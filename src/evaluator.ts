/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

import { Content, FunctionDeclaration, GoogleGenAI, Part } from "@google/genai";
import { MockResolver } from "./mockResolver.js";
import { evaluateExecutionTrajectory } from "./trajectory.js";
import {
  CaseRunResult,
  EvalCase,
  EvalCategory,
  EvalMessage,
  SuiteEvalSummary,
  Tool,
  ToolCall,
  ToolsSchemaFile,
  TrajectoryStepRecord,
} from "./types.js";

/**
 * Matches the default system prompt used in `webmcp-evals` (`src/evaluator/prompts.ts`).
 */
export const SYSTEM_PROMPT = `
# INSTRUCTIONS
You are an agent helping a user navigate a page via the tools made available to you. You must
use the provided tools to query page content when you absolutely need it.
CRITICAL RULE: Do not try to use other tools than the available ones. Never use more tool calls than necessary.

# ADDITIONAL CONTEXT
Today's date is: 2026-11-03.
`;

/**
 * Official Gemini API thoughtSignature bypass token (base64-encoded
 * "skip_thought_signature_validator") for pre-seeded synthetic functionCall
 * messages in multi-turn evaluation histories.
 */
const SYNTHETIC_THOUGHT_SIGNATURE = Buffer.from(
  "skip_thought_signature_validator",
).toString("base64");

export function mapSchemaFileToTools(schemaFile: ToolsSchemaFile): Tool[] {
  return schemaFile.tools.map((t) => ({
    functionName: t.name,
    description: t.description,
    parameters:
      t.inputSchema && Object.keys(t.inputSchema).length > 0
        ? t.inputSchema
        : { type: "object", properties: {} },
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations,
  }));
}

export function buildGeminiFunctionDeclarations(tools: Tool[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.functionName,
    description: t.description,
    parametersJsonSchema: t.parameters,
    ...(t.outputSchema ? { responseJsonSchema: t.outputSchema } : {}),
  }));
}

export function mapEvalMessagesToGeminiContents(messages: EvalMessage[]): Content[] {
  return messages.map((m): Content => {
    switch (m.type) {
      case "message":
        return {
          role: m.role === "assistant" ? "model" : m.role,
          parts: [{ text: m.content }],
        };
      case "functioncall":
        return {
          role: "model",
          parts: [
            {
              functionCall: {
                name: m.name,
                args: m.arguments,
              },
              thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE,
            },
          ],
        };
      case "functionresponse":
        return {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: m.name,
                response: m.response,
              },
            },
          ],
        };
    }
  });
}

export interface EvaluatorOptions {
  apiKey: string;
  model: string;
  runs?: number;
  maxSteps?: number;
  systemPrompt?: string;
  onCaseComplete?: (result: CaseRunResult, index: number, total: number) => void;
}

export class GeminiOutputSchemaEvaluator {
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly maxSteps: number;
  private readonly systemPrompt: string;

  constructor(options: EvaluatorOptions) {
    const baseUrl = process.env.GOOGLE_GENERATIVE_AI_BASE_URL;
    this.ai = new GoogleGenAI({
      apiKey: options.apiKey,
      ...(baseUrl ? { httpOptions: { baseUrl } } : {}),
    });
    this.model = options.model;
    this.maxSteps = options.maxSteps ?? 6;
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
  }

  /**
   * Executes a single test case across multiple tool-calling steps (up to `maxSteps`),
   * resolving intermediate tool outputs via `MockResolver`.
   */
  async runCase(
    testCase: EvalCase,
    tools: Tool[],
    runIndex: number,
  ): Promise<CaseRunResult> {
    const category: EvalCategory = testCase.category ?? "control";
    const resolver = new MockResolver(testCase.expectedCall);
    const functionDeclarations = buildGeminiFunctionDeclarations(tools);
    const validToolNames = new Set(tools.map((t) => t.functionName));
    const contents: Content[] = mapEvalMessagesToGeminiContents(testCase.messages);

    const executedCalls: ToolCall[] = [];
    const steps: TrajectoryStepRecord[] = [];

    try {
      for (let stepNum = 1; stepNum <= this.maxSteps; stepNum++) {
        const response = await this.ai.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: this.systemPrompt,
            tools: [{ functionDeclarations }],
          },
        });

        const candidateContent = response.candidates?.[0]?.content;
        const rawCalls = (response.functionCalls ?? []).filter(
          (fc) => fc.name && validToolNames.has(fc.name),
        );

        const textParts = candidateContent?.parts
          ?.map((p) => p.text)
          .filter((t): t is string => Boolean(t))
          .join("");

        if (rawCalls.length === 0) {
          if (textParts) {
            steps.push({
              stepNumber: stepNum,
              text: textParts,
              toolCalls: [],
            });
          }
          break;
        }

        const stepCalls: ToolCall[] = [];
        const responseParts: Part[] = [];

        for (const call of rawCalls) {
          const fnName = call.name!;
          const args = (call.args as Record<string, unknown>) ?? {};
          const mockResult = resolver.resolve(fnName, args);

          const recordedCall: ToolCall = {
            functionName: fnName,
            args,
            result: mockResult,
          };
          executedCalls.push(recordedCall);
          stepCalls.push(recordedCall);

          const normalizedResponse: Record<string, unknown> =
            mockResult !== null &&
            typeof mockResult === "object" &&
            !Array.isArray(mockResult)
              ? (mockResult as Record<string, unknown>)
              : { result: mockResult };

          responseParts.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: fnName,
              response: normalizedResponse,
            },
          });
        }

        steps.push({
          stepNumber: stepNum,
          text: textParts || undefined,
          toolCalls: stepCalls,
        });

        // Preserve exact candidate content (including Gemini 2.5/3 thoughtSignature)
        if (candidateContent) {
          contents.push(candidateContent);
        } else {
          contents.push({
            role: "model",
            parts: rawCalls.map((c) => ({
              functionCall: {
                name: c.name!,
                args: (c.args as Record<string, unknown>) ?? {},
              },
            })),
          });
        }

        contents.push({
          role: "user",
          parts: responseParts,
        });
      }

      const trajectoryResults = evaluateExecutionTrajectory(
        testCase.expectedCall,
        executedCalls,
      );
      const stepsTotal = trajectoryResults.length;
      const stepsPassed = trajectoryResults.filter((t) => t.outcome === "pass").length;
      const passed = stepsTotal === 0 ? true : stepsPassed === stepsTotal;

      return {
        testName: testCase.name,
        category,
        runIndex,
        passed,
        stepsPassed,
        stepsTotal,
        executedCalls,
        trajectoryResults,
        steps,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        testName: testCase.name,
        category,
        runIndex,
        passed: false,
        stepsPassed: 0,
        stepsTotal: testCase.expectedCall?.length ?? 1,
        executedCalls,
        trajectoryResults: [],
        steps,
        error: errorMsg,
      };
    }
  }

  async runSuite(
    schemaFilePath: string,
    schemaFile: ToolsSchemaFile,
    evalCases: EvalCase[],
    runs: number = 1,
    onCaseComplete?: (result: CaseRunResult, index: number, total: number) => void,
  ): Promise<SuiteEvalSummary> {
    const tools = mapSchemaFileToTools(schemaFile);
    const hasOutputSchema = tools.some((t) => t.outputSchema != null);
    const results: CaseRunResult[] = [];
    const totalRuns = evalCases.length * runs;
    let currentIdx = 0;

    for (let r = 1; r <= runs; r++) {
      for (const testCase of evalCases) {
        currentIdx++;
        const res = await this.runCase(testCase, tools, r);
        results.push(res);
        if (onCaseComplete) {
          onCaseComplete(res, currentIdx, totalRuns);
        }
      }
    }

    return summarizeSuiteResults(schemaFilePath, hasOutputSchema, this.model, runs, results);
  }
}

export function summarizeSuiteResults(
  schemaFile: string,
  hasOutputSchema: boolean,
  model: string,
  runs: number,
  results: CaseRunResult[],
): SuiteEvalSummary {
  const categories: EvalCategory[] = [
    "single_turn_disambiguation",
    "multi_step_chaining",
    "multi_turn_conversation",
    "control",
  ];

  const byCategory = {} as SuiteEvalSummary["byCategory"];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const totalCases = catResults.length;
    const passedCases = catResults.filter((r) => r.passed).length;
    const totalSteps = catResults.reduce((acc, r) => acc + r.stepsTotal, 0);
    const passedSteps = catResults.reduce((acc, r) => acc + r.stepsPassed, 0);

    byCategory[cat] = {
      totalCases,
      passedCases,
      casePassRate: totalCases > 0 ? Number(((passedCases / totalCases) * 100).toFixed(1)) : 0,
      totalSteps,
      passedSteps,
      stepPassRate: totalSteps > 0 ? Number(((passedSteps / totalSteps) * 100).toFixed(1)) : 0,
    };
  }

  const totalCases = results.length;
  const passedCases = results.filter((r) => r.passed).length;
  const totalSteps = results.reduce((acc, r) => acc + r.stepsTotal, 0);
  const passedSteps = results.reduce((acc, r) => acc + r.stepsPassed, 0);

  return {
    schemaFile,
    hasOutputSchema,
    model,
    runs,
    totalCases,
    passedCases,
    casePassRate: totalCases > 0 ? Number(((passedCases / totalCases) * 100).toFixed(1)) : 0,
    totalSteps,
    passedSteps,
    stepPassRate: totalSteps > 0 ? Number(((passedSteps / totalSteps) * 100).toFixed(1)) : 0,
    byCategory,
    results,
  };
}
