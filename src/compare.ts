/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { printSummaryTable, resolveApiKey } from "./cli.js";
import { GeminiOutputSchemaEvaluator } from "./evaluator.js";
import { EvalCase, EvalCategory, SuiteEvalSummary, ToolsSchemaFile } from "./types.js";

dotenv.config();

export function renderComparisonMarkdown(
  withoutOutput: SuiteEvalSummary,
  withOutput: SuiteEvalSummary,
): string {
  const categories: EvalCategory[] = [
    "single_turn_disambiguation",
    "multi_step_chaining",
    "multi_turn_conversation",
    "control",
  ];

  const formatDelta = (a: number, b: number): string => {
    const diff = Number((b - a).toFixed(1));
    return diff > 0 ? `+${diff}%` : `${diff}%`;
  };

  const lines: string[] = [
    `# WebMCP \`outputSchema\` Impact Evaluation Report`,
    ``,
    `- **Model**: \`${withOutput.model}\``,
    `- **Runs per Eval Case**: \`${withOutput.runs}\``,
    `- **Total Eval Cases**: \`${withOutput.totalCases / withOutput.runs}\` (${withOutput.totalCases} total executions per toolset)`,
    ``,
    `## 1. Overall Summary`,
    ``,
    `| Metric | Without \`outputSchema\` | With \`outputSchema\` (\`responseJsonSchema\`) | Delta |`,
    `| :--- | :---: | :---: | :---: |`,
    `| **Case Pass Rate** | ${withoutOutput.passedCases}/${withoutOutput.totalCases} (${withoutOutput.casePassRate}%) | ${withOutput.passedCases}/${withOutput.totalCases} (${withOutput.casePassRate}%) | **${formatDelta(withoutOutput.casePassRate, withOutput.casePassRate)}** |`,
    `| **Step Pass Rate** | ${withoutOutput.passedSteps}/${withoutOutput.totalSteps} (${withoutOutput.stepPassRate}%) | ${withOutput.passedSteps}/${withOutput.totalSteps} (${withOutput.stepPassRate}%) | **${formatDelta(withoutOutput.stepPassRate, withOutput.stepPassRate)}** |`,
    ``,
    `## 2. Breakdown by Evaluation Category`,
    ``,
    `| Category | Without \`outputSchema\` (Cases) | With \`outputSchema\` (Cases) | Case Delta | Without \`outputSchema\` (Steps) | With \`outputSchema\` (Steps) | Step Delta |`,
    `| :--- | :---: | :---: | :---: | :---: | :---: | :---: |`,
  ];

  for (const cat of categories) {
    const wo = withoutOutput.byCategory[cat];
    const wi = withOutput.byCategory[cat];
    if (!wo || wo.totalCases === 0) continue;
    lines.push(
      `| \`${cat}\` | ${wo.passedCases}/${wo.totalCases} (${wo.casePassRate}%) | ${wi.passedCases}/${wi.totalCases} (${wi.casePassRate}%) | **${formatDelta(wo.casePassRate, wi.casePassRate)}** | ${wo.passedSteps}/${wo.totalSteps} (${wo.stepPassRate}%) | ${wi.passedSteps}/${wi.totalSteps} (${wi.stepPassRate}%) | **${formatDelta(wo.stepPassRate, wi.stepPassRate)}** |`,
    );
  }

  lines.push(``, `## 3. Per-Case Comparison`, ``);
  lines.push(
    `| Eval Case | Category | Without \`outputSchema\` | With \`outputSchema\` | Tool Trajectory (Without -> With) |`,
  );
  lines.push(`| :--- | :--- | :---: | :---: | :--- |`);

  const caseNames = Array.from(new Set(withOutput.results.map((r) => r.testName)));
  for (const name of caseNames) {
    const woRuns = withoutOutput.results.filter((r) => r.testName === name);
    const wiRuns = withOutput.results.filter((r) => r.testName === name);
    const cat = wiRuns[0]?.category ?? "control";
    const woPass = woRuns.filter((r) => r.passed).length;
    const wiPass = wiRuns.filter((r) => r.passed).length;
    const woCalls =
      woRuns[0]?.executedCalls.map((c) => c.functionName).join(" → ") || "(none)";
    const wiCalls =
      wiRuns[0]?.executedCalls.map((c) => c.functionName).join(" → ") || "(none)";
    lines.push(
      `| ${name} | \`${cat}\` | ${woPass}/${woRuns.length} | ${wiPass}/${wiRuns.length} | \`${woCalls}\` vs \`${wiCalls}\` |`,
    );
  }

  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      withoutSchema: { type: "string", default: "schemas/schema-without-output.json" },
      withSchema: { type: "string", default: "schemas/schema-with-output.json" },
      evals: { type: "string", short: "e", default: "evals/evals.json" },
      model: { type: "string", short: "m", default: "gemini-3-flash-preview" },
      runs: { type: "string", short: "r", default: "1" },
      maxSteps: { type: "string", default: "6" },
      filter: { type: "string", short: "f", default: "" },
      outputDir: { type: "string", short: "o", default: ".evals" },
    },
  });

  const apiKey = resolveApiKey();
  const runs = Number.parseInt(values.runs!, 10) || 1;
  const maxSteps = Number.parseInt(values.maxSteps!, 10) || 6;

  const withoutSchemaFile: ToolsSchemaFile = JSON.parse(
    await readFile(resolve(process.cwd(), values.withoutSchema!), "utf-8"),
  );
  const withSchemaFile: ToolsSchemaFile = JSON.parse(
    await readFile(resolve(process.cwd(), values.withSchema!), "utf-8"),
  );
  const allEvalCases: EvalCase[] = JSON.parse(
    await readFile(resolve(process.cwd(), values.evals!), "utf-8"),
  );
  const filterRegex = values.filter ? new RegExp(values.filter, "i") : null;
  const evalCases = filterRegex
    ? allEvalCases.filter(
        (c) => filterRegex.test(c.name) || filterRegex.test(c.category ?? ""),
      )
    : allEvalCases;

  const evaluator = new GeminiOutputSchemaEvaluator({
    apiKey,
    model: values.model!,
    runs,
    maxSteps,
  });

  console.log(`\n[1/2] Running evaluation WITHOUT outputSchema (${values.withoutSchema})...`);
  const withoutSummary = await evaluator.runSuite(
    values.withoutSchema!,
    withoutSchemaFile,
    evalCases,
    runs,
    (res, idx, total) => {
      process.stdout.write(`  [without ${idx}/${total}] ${res.passed ? "✓" : "✗"} ${res.testName}\n`);
    },
  );
  printSummaryTable(withoutSummary);

  console.log(`\n[2/2] Running evaluation WITH outputSchema (${values.withSchema})...`);
  const withSummary = await evaluator.runSuite(
    values.withSchema!,
    withSchemaFile,
    evalCases,
    runs,
    (res, idx, total) => {
      process.stdout.write(`  [with    ${idx}/${total}] ${res.passed ? "✓" : "✗"} ${res.testName}\n`);
    },
  );
  printSummaryTable(withSummary);

  const markdown = renderComparisonMarkdown(withoutSummary, withSummary);
  console.log("\n" + markdown);

  const outDir = resolve(process.cwd(), values.outputDir!);
  await mkdir(outDir, { recursive: true });
  const ts = Date.now();
  const mdPath = resolve(outDir, `comparison-${ts}.md`);
  const jsonPath = resolve(outDir, `comparison-${ts}.json`);

  await writeFile(mdPath, markdown, "utf-8");
  await writeFile(
    jsonPath,
    JSON.stringify({ withoutOutput: withoutSummary, withOutput: withSummary }, null, 2),
    "utf-8",
  );
  console.log(`Saved comparison report to:\n  - ${mdPath}\n  - ${jsonPath}`);
}

const isDirectRun =
  process.argv[1] && resolve(process.argv[1]).endsWith("compare.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
