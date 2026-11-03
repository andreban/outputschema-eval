/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  buildGeminiFunctionDeclarations,
  mapEvalMessagesToGeminiContents,
  mapSchemaFileToTools,
} from "../evaluator.js";
import { matchesArgument } from "../matcher.js";
import { MockResolver } from "../mockResolver.js";
import { evaluateExecutionTrajectory } from "../trajectory.js";
import { EvalCase, ToolsSchemaFile } from "../types.js";

function assertSchemaPropertiesPassBudgets(
  toolName: string,
  schemaLabel: string,
  node: Record<string, unknown> | null | undefined,
): void {
  if (!node || typeof node !== "object") return;
  const props = node.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const [propName, propDef] of Object.entries(props)) {
      assert.ok(
        propName.length <= 30,
        `${toolName} (${schemaLabel}): property name "${propName}" exceeds 30 chars (${propName.length})`,
      );
      assert.equal(
        typeof propDef.description,
        "string",
        `${toolName} (${schemaLabel}): property "${propName}" is missing a description`,
      );
      const desc = propDef.description as string;
      assert.ok(
        desc.length > 0 && desc.length <= 150,
        `${toolName} (${schemaLabel}): property "${propName}" description length (${desc.length}) must be 1..150`,
      );
      if (propDef.type === "object") {
        assertSchemaPropertiesPassBudgets(toolName, `${schemaLabel}.${propName}`, propDef);
      } else if (propDef.type === "array" && propDef.items) {
        assertSchemaPropertiesPassBudgets(
          toolName,
          `${schemaLabel}.${propName}[]`,
          propDef.items as Record<string, unknown>,
        );
      }
    }
  }
}

describe("Paired Toolset Schemas & WebMCP Audits", () => {
  it("ensures schema-without-output.json and schema-with-output.json are identical except for outputSchema", async () => {
    const withoutRaw = await readFile(
      resolve(process.cwd(), "schemas/schema-without-output.json"),
      "utf-8",
    );
    const withRaw = await readFile(
      resolve(process.cwd(), "schemas/schema-with-output.json"),
      "utf-8",
    );

    const withoutSchema: ToolsSchemaFile = JSON.parse(withoutRaw);
    const withSchema: ToolsSchemaFile = JSON.parse(withRaw);

    assert.equal(withoutSchema.tools.length, withSchema.tools.length);
    assert.equal(withoutSchema.tools.length, 17);

    for (let i = 0; i < withSchema.tools.length; i++) {
      const a = withoutSchema.tools[i];
      const b = withSchema.tools[i];

      assert.equal(a.name, b.name, `Tool index ${i} name mismatch`);
      assert.equal(a.description, b.description, `Tool ${a.name} description mismatch`);
      assert.deepEqual(a.inputSchema, b.inputSchema, `Tool ${a.name} inputSchema mismatch`);
      assert.deepEqual(a.annotations, b.annotations, `Tool ${a.name} annotations mismatch`);

      assert.equal(
        a.outputSchema,
        undefined,
        `Expected omitted outputSchema on ${a.name} in schema-without-output.json`,
      );
      assert.ok(
        b.outputSchema && typeof b.outputSchema === "object",
        `Expected non-null outputSchema on ${b.name} in schema-with-output.json`,
      );
    }
  });

  it("enforces all WebMCP checklist rules (budgets, What+When, no inputSchema repetition, no jargon, opt-in annotations)", async () => {
    const withRaw = await readFile(
      resolve(process.cwd(), "schemas/schema-with-output.json"),
      "utf-8",
    );
    const withSchema: ToolsSchemaFile = JSON.parse(withRaw);

    const forbiddenJargon =
      /\b(redux|pinia|express|postgres|rest|graphql|grpc|react query|signals|mutation handler|controller|cache invalidation)\b/i;

    for (const tool of withSchema.tools) {
      assert.ok(
        tool.name.length <= 30,
        `Tool name "${tool.name}" exceeds 30-char limit (${tool.name.length})`,
      );
      assert.ok(
        tool.description.length <= 500,
        `Tool "${tool.name}" description exceeds 500-char limit (${tool.description.length})`,
      );
      assert.ok(
        tool.description.includes("Use when "),
        `Tool "${tool.name}" description must follow the 'What + When' formula ('Use when ...')`,
      );
      assert.equal(
        forbiddenJargon.test(tool.description),
        false,
        `Tool "${tool.name}" description contains forbidden implementation jargon`,
      );

      // Ensure inputSchema parameter names are not repeated verbatim in tool description
      const inputProps = Object.keys(
        (tool.inputSchema?.properties ?? {}) as Record<string, unknown>,
      );
      for (const paramName of inputProps) {
        const paramRegex = new RegExp(`\\b${paramName}\\b`, "i");
        assert.equal(
          paramRegex.test(tool.description),
          false,
          `Tool "${tool.name}" description repeats inputSchema parameter "${paramName}"`,
        );
      }

      // Check budgets and descriptions recursively on both inputSchema and outputSchema
      assertSchemaPropertiesPassBudgets(tool.name, "inputSchema", tool.inputSchema);
      assertSchemaPropertiesPassBudgets(tool.name, "outputSchema", tool.outputSchema);

      // Check annotations rules
      if (tool.annotations) {
        for (const [hintKey, hintVal] of Object.entries(tool.annotations)) {
          assert.equal(
            hintVal,
            true,
            `Annotation "${hintKey}" on "${tool.name}" must be strictly opt-in (never false)`,
          );
        }
        assert.equal(
          Boolean(tool.annotations.readOnlyHint && tool.annotations.consequentialHint),
          false,
          `Tool "${tool.name}" cannot declare both readOnlyHint and consequentialHint`,
        );
      }
      if (tool.name.startsWith("initiate_")) {
        assert.equal(
          tool.annotations,
          undefined,
          `UI hand-off tool "${tool.name}" must omit annotations (not readOnlyHint or consequentialHint)`,
        );
      }
    }
  });

  it("wires outputSchema to Gemini FunctionDeclaration.responseJsonSchema only when present", async () => {
    const withoutSchema: ToolsSchemaFile = JSON.parse(
      await readFile(resolve(process.cwd(), "schemas/schema-without-output.json"), "utf-8"),
    );
    const withSchema: ToolsSchemaFile = JSON.parse(
      await readFile(resolve(process.cwd(), "schemas/schema-with-output.json"), "utf-8"),
    );

    const declsWithout = buildGeminiFunctionDeclarations(mapSchemaFileToTools(withoutSchema));
    const declsWith = buildGeminiFunctionDeclarations(mapSchemaFileToTools(withSchema));

    for (const d of declsWithout) {
      assert.equal("responseJsonSchema" in d, false);
    }
    for (const d of declsWith) {
      assert.equal("responseJsonSchema" in d, true);
      assert.ok(d.responseJsonSchema && typeof d.responseJsonSchema === "object");
    }
  });
});

describe("Evaluation Suite & Trajectory Matcher", () => {
  it("validates all 6 high-signal eval cases in evals/evals.json", async () => {
    const rawEvals = await readFile(resolve(process.cwd(), "evals/evals.json"), "utf-8");
    const evals: EvalCase[] = JSON.parse(rawEvals);
    assert.equal(evals.length, 6);

    for (const c of evals) {
      assert.ok(c.name.length > 0);
      assert.ok(Array.isArray(c.messages) && c.messages.length > 0);
      assert.ok(Array.isArray(c.expectedCall) && c.expectedCall.length > 0);

      const contents = mapEvalMessagesToGeminiContents(c.messages);
      assert.equal(contents.length, c.messages.length);
    }
  });

  it("matches $pattern, $contains, numeric operators, and multi-step trajectories", () => {
    assert.equal(matchesArgument({ $pattern: "standing desk" }, "Standing Desk Pro"), true);
    assert.equal(matchesArgument({ $gte: 10, $lte: 20 }, 15), true);
    assert.equal(matchesArgument({ $contains: "MON" }, "SKU-MON-34B"), true);

    const expected = [
      {
        functionName: "get_product_specs",
        arguments: { product_id: "PROD-10" },
        mockOutput: { variants: [{ sku_code: "SKU-MON-34G" }] },
      },
      {
        functionName: "update_cart_items",
        arguments: { items: [{ sku_code: "SKU-MON-34G", quantity: 2 }] },
      },
    ];

    const resolver = new MockResolver(expected);
    assert.deepEqual(resolver.resolve("get_product_specs"), {
      variants: [{ sku_code: "SKU-MON-34G" }],
    });

    const trajectory = evaluateExecutionTrajectory(expected, [
      { functionName: "get_product_specs", args: { product_id: "PROD-10" } },
      {
        functionName: "update_cart_items",
        args: { items: [{ sku_code: "SKU-MON-34G", quantity: 2 }] },
      },
    ]);
    assert.equal(trajectory.length, 2);
    assert.ok(trajectory.every((t) => t.outcome === "pass"));
  });
});
