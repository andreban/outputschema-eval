/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  annotations?: ToolAnnotations;
}

export interface ToolsSchemaFile {
  tools: ToolSchema[];
}

export interface Tool {
  functionName: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  annotations?: ToolAnnotations;
}

export interface ToolCall {
  functionName: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface TextMessage {
  role: "user" | "model" | "assistant";
  type: "message";
  content: string;
}

export interface FunctionCallMessage {
  role: "model" | "assistant";
  type: "functioncall";
  name: string;
  arguments: Record<string, unknown>;
}

export interface FunctionResponseMessage {
  role: "user";
  type: "functionresponse";
  name: string;
  response: Record<string, unknown>;
}

export type EvalMessage = TextMessage | FunctionCallMessage | FunctionResponseMessage;

export interface ExpectedFunctionCall {
  functionName: string;
  arguments?: Record<string, unknown> | null;
  mockOutput?: unknown;
  result?: unknown;
  optional?: boolean;
}

export type ExpectedCallNode =
  | ExpectedFunctionCall
  | { ordered: ExpectedCallNode[] }
  | { unordered: ExpectedCallNode[] };

export type EvalCategory =
  | "single_turn_disambiguation"
  | "multi_step_chaining"
  | "multi_turn_conversation"
  | "control";

export interface EvalCase {
  name: string;
  category?: EvalCategory;
  description?: string;
  messages: EvalMessage[];
  expectedCall: ExpectedCallNode[] | null;
}

export interface TrajectoryStepRecord {
  stepNumber: number;
  text?: string;
  toolCalls: ToolCall[];
}

export interface TrajectoryComparisonItem {
  expected: ExpectedFunctionCall | null;
  actual: ToolCall | null;
  outcome: "pass" | "fail";
}

export interface CaseRunResult {
  testName: string;
  category: EvalCategory;
  runIndex: number;
  passed: boolean;
  stepsPassed: number;
  stepsTotal: number;
  executedCalls: ToolCall[];
  trajectoryResults: TrajectoryComparisonItem[];
  steps: TrajectoryStepRecord[];
  error?: string;
}

export interface SuiteEvalSummary {
  schemaFile: string;
  hasOutputSchema: boolean;
  model: string;
  runs: number;
  totalCases: number;
  passedCases: number;
  casePassRate: number;
  totalSteps: number;
  passedSteps: number;
  stepPassRate: number;
  byCategory: Record<
    EvalCategory,
    {
      totalCases: number;
      passedCases: number;
      casePassRate: number;
      totalSteps: number;
      passedSteps: number;
      stepPassRate: number;
    }
  >;
  results: CaseRunResult[];
}
