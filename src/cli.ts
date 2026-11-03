/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GeminiOutputSchemaEvaluator } from "./evaluator.js";
import { EvalCase, SuiteEvalSummary, ToolsSchemaFile } from "./types.js";

dotenv.config();

export function resolveApiKey(): string {
  const key =
    process.env.GOOGLE_AI ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing Gemini API key in environment (.env). Expected GOOGLE_AI, GEMINI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.",
    );
  }
  return key;
}

export function printSummaryTable(summary: SuiteEvalSummary): void {
  const modeLabel = summary.hasOutputSchema
    ? "WITH outputSchema (responseJsonSchema)"
    : "WITHOUT outputSchema";
  console.log(`\n========================================================================`);
  console.log(`  Suite: ${summary.schemaFile} [${modeLabel}]`);
  console.log(`  Model: ${summary.model} | Runs: ${summary.runs}`);
  console.log(`========================================================================\n`);

  for (const r of summary.results) {
    const badge = r.passed ? "✅ PASS" : r.error ? "💥 ERR " : "❌ FAIL";
    const actualNames = r.executedCalls.map((c) => c.functionName).join(" -> ") || "(none)";
    console.log(
      `${badge} [Run ${r.runIndex}] [${r.category}] ${r.testName} (${r.stepsPassed}/${r.stepsTotal} steps) | Calls: ${actualNames}`,
    );
    if (!r.passed && r.error) {
      console.log(`       Error: ${r.error}`);
    } else if (!r.passed) {
      for (const item of r.trajectoryResults) {
        if (item.outcome === "fail") {
          const expStr = item.expected
            ? `${item.expected.functionName}(${JSON.stringify(item.expected.arguments ?? {})})`
            : "(no further calls)";
          const actStr = item.actual
            ? `${item.actual.functionName}(${JSON.stringify(item.actual.args)})`
            : "(missing call)";
          console.log(`       Expected: ${expStr}`);
          console.log(`       Actual:   ${actStr}`);
        }
      }
    }
  }

  console.log(`\n--- Breakdown by Category ---`);
  for (const [cat, stats] of Object.entries(summary.byCategory)) {
    if (stats.totalCases === 0) continue;
    console.log(
      `  ${cat.padEnd(28)}: Cases ${stats.passedCases}/${stats.totalCases} (${stats.casePassRate}%) | Steps ${stats.passedSteps}/${stats.totalSteps} (${stats.stepPassRate}%)`,
    );
  }
  console.log(
    `\nOverall Cases: ${summary.passedCases}/${summary.totalCases} (${summary.casePassRate}%) | Overall Steps: ${summary.passedSteps}/${summary.totalSteps} (${summary.stepPassRate}%)\n`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tools: { type: "string", short: "t", default: "schemas/schema-with-output.json" },
      evals: { type: "string", short: "e", default: "evals/evals.json" },
      model: { type: "string", short: "m", default: "gemini-3-flash-preview" },
      runs: { type: "string", short: "r", default: "1" },
      maxSteps: { type: "string", default: "6" },
      outputDir: { type: "string", short: "o", default: ".evals" },
    },
  });

  const apiKey = resolveApiKey();
  const toolsPath = resolve(process.cwd(), values.tools!);
  const evalsPath = resolve(process.cwd(), values.evals!);
  const runs = Number.parseInt(values.runs!, 10) || 1;
  const maxSteps = Number.parseInt(values.maxSteps!, 10) || 6;

  const schemaFile: ToolsSchemaFile = JSON.parse(await readFile(toolsPath, "utf-8"));
  const evalCases: EvalCase[] = JSON.parse(await readFile(evalsPath, "utf-8"));

  const evaluator = new GeminiOutputSchemaEvaluator({
    apiKey,
    model: values.model!,
    runs,
    maxSteps,
  });

  const summary = await evaluator.runSuite(
    values.tools!,
    schemaFile,
    evalCases,
    runs,
    (res, idx, total) => {
      const icon = res.passed ? "✓" : "✗";
      process.stdout.write(`  [${idx}/${total}] ${icon} ${res.testName}\n`);
    },
  );

  printSummaryTable(summary);

  const outDir = resolve(process.cwd(), values.outputDir!);
  await mkdir(outDir, { recursive: true });
  const reportPath = resolve(outDir, `report-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`Saved JSON report to ${reportPath}`);
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]).endsWith("cli.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
