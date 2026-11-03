# WebMCP `outputSchema` Impact Evaluation (`outputschema-eval`)

TypeScript evaluation suite measuring the impact of WebMCP's [`outputSchema`](https://github.com/webmachinelearning/webmcp/pull/254) on an LLM agent's ability to select the right tools and pass the right parameters across single-turn disambiguation, multi-step chaining, and multi-turn conversations.

- **ZNotes Report**: `"WebMCP outputSchema Impact Evaluation Report"` (Note ID: `559e7761-7eb7-41c9-85a0-d24c1dd450ee` in `--path "webmcp/webmcp-evals"`)
- **Committed Evaluation Outputs**:
  - [`.evals/comparison-1793722245134.md`](./.evals/comparison-1793722245134.md) (Markdown summary, 3 runs per case)
  - [`.evals/comparison-1793722245134.json`](./.evals/comparison-1793722245134.json) (Full JSON trajectories and per-step outcomes, 3 runs per case)

---

## 1. Evaluation Outcomes (`gemini-3-flash-preview`, `-r 3`)

Both [`schemas/schema-without-output.json`](./schemas/schema-without-output.json) and [`schemas/schema-with-output.json`](./schemas/schema-with-output.json) define **17 WebMCP tools** verified by automated unit tests ([`src/test/evaluator.test.ts`](./src/test/evaluator.test.ts)) against all WebMCP best-practice rules (tool/property name length budgets, <= 500-character `"What + When"` descriptions, <= 150-character property descriptions, zero `inputSchema` parameter repetition in descriptions, zero implementation jargon, and opt-in annotations). The two files are byte-for-byte identical except for `outputSchema`.

Low-value cases that pass both with and without `outputSchema` were removed from [`evals/evals.json`](./evals/evals.json), leaving **6 high-signal evaluation cases** executed **3 times each (`18` executions per toolset)**:

### Overall Summary

| Metric | Without `outputSchema` | With `outputSchema` (`responseJsonSchema`) | Delta |
| :--- | :---: | :---: | :---: |
| **Overall Case Pass Rate** | **1 / 18 (5.6%)** | **16 / 18 (88.9%)** | **+83.3%** |
| **Overall Step Pass Rate** | **2 / 57 (3.5%)** | **26 / 33 (78.8%)** | **+75.3%** |
| **Total Tool Calls Made** | **57 calls** (27 wasted exploratory calls) | **33 calls** (3 wasted calls) | **-42.1% tool calls** |

### Breakdown by Evaluation Category

| Category | Without `outputSchema` (Cases) | With `outputSchema` (Cases) | Case Delta | Without `outputSchema` (Steps) | With `outputSchema` (Steps) | Step Delta |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `single_turn_disambiguation` | 0 / 6 (0%) | 6 / 6 (100%) | **+100.0%** | 0 / 11 (0%) | 6 / 6 (100%) | **+100.0%** |
| `multi_step_chaining` | 1 / 9 (11.1%) | 7 / 9 (77.8%) | **+66.7%** | 2 / 34 (5.9%) | 14 / 21 (66.7%) | **+60.8%** |
| `multi_turn_conversation` | 0 / 3 (0%) | 3 / 3 (100%) | **+100.0%** | 0 / 12 (0%) | 6 / 6 (100%) | **+100.0%** |

### Per-Case Multi-Run Comparison (`3 runs per case`)

| # | Eval Case | Category | Without `outputSchema` | With `outputSchema` | Representative Trajectory (`Without` -> `With`) |
| :- | :--- | :--- | :---: | :---: | :--- |
| 1 | **Disambiguate Tax Exemption Certificate ID** (`get_corporate_policy` vs `get_user_preferences` / `get_loyalty_benefits`) | `single_turn_disambiguation` | **0 / 3** | **3 / 3** | `get_user_preferences -> get_corporate_policy` vs `get_corporate_policy` |
| 2 | **Disambiguate Saved Home Airport Lookup** (`get_loyalty_benefits` vs `get_user_preferences`) | `single_turn_disambiguation` | **0 / 3** | **3 / 3** | `get_user_preferences -> get_loyalty_benefits` vs `get_loyalty_benefits` |
| 3 | **Chain: Search Flights to NYC from Usual Location** (`get_loyalty_benefits` -> `search_flights`) | `multi_step_chaining` | **0 / 3** | **1 / 3** | `get_user_preferences -> get_loyalty_benefits -> search_flights` vs `get_loyalty_benefits -> search_flights` |
| 4 | **Chain: Search Flights from NYC to Usual Location** (`get_loyalty_benefits` -> `search_flights`) | `multi_step_chaining` | **0 / 3** | **3 / 3** | `get_user_preferences -> list_customer_orders -> get_corporate_policy -> get_loyalty_benefits -> search_flights` vs `get_loyalty_benefits -> search_flights` |
| 5 | **Chain: Add Official Replacement Power Adapter to Cart** (`get_product_specs` -> `update_cart_items`) | `multi_step_chaining` | **1 / 3** | **3 / 3** | `search_catalog -> search_catalog -> get_product_specs -> update_cart_items` vs `get_product_specs -> update_cart_items` |
| 6 | **Multi-Turn: Catalog Search Followed by Replacement Adapter Stock Check** (`get_product_specs` -> `check_warehouse_stock`) | `multi_turn_conversation` | **0 / 3** | **3 / 3** | `search_catalog -> search_catalog -> get_product_specs -> check_warehouse_stock` vs `get_product_specs -> check_warehouse_stock` |

---

## 2. Why Cases Fail Without `outputSchema` and Succeed With It

When a tool returns only 1–2 narrow concepts, a WebMCP `"What + When"` description and `inputSchema` alone are sufficient. However, two core WebMCP design rules create a structural gap for consolidated read tools:

1. **Tool Consolidation (No Getter Bloat)**: Instead of exposing dozens of single-property getters (`get_home_airport`, `get_tax_exempt_cert_id`, `get_replacement_adapter_sku`), WebMCP applications consolidate related state into domain read tools (`get_user_preferences`, `get_loyalty_benefits`, `get_corporate_policy`, `get_product_specs`), each returning 7–12 fields.
2. **<= 500-Character Description Budget**: Listing 10–14 returned property names and descriptions in prose would require 800–1,200+ characters, violating the <= 500-character `"What + When"` description limit.

### Key Examples from the Suite

- **Implicit User Location in Flight Search (`get_loyalty_benefits` -> `search_flights`, Cases #3 & #4)**:
  - **Prompt**: *"I want to travel from NYC (JFK) to my usual location on 2026-11-25. What flights are available?"*
  - **Without `outputSchema` (`0/3`)**: The model cannot see that `home_airport_iata` lives in `get_loyalty_benefits` rather than `get_user_preferences`. On all runs, it calls `get_user_preferences({})` first, receives no airport code, and blindly probes `list_customer_orders({})` and `get_corporate_policy({})` before finding `get_loyalty_benefits({})` (5 calls instead of 2).
  - **With `outputSchema` (`3/3` on Case #4, `1/3` on Case #3)**: The model inspects `responseJsonSchema`, spots `home_airport_iata` inside `get_loyalty_benefits.outputSchema`, and executes `get_loyalty_benefits -> search_flights` in 2 steps.
- **Hidden Replacement Part SKU (`get_product_specs` -> `update_cart_items` / `check_warehouse_stock`, Cases #5 & #6)**:
  - **Prompt**: *"Add 1 unit of the official replacement power adapter for product PROD-10 to my cart."* (and multi-turn stock check in Case #6).
  - **Without `outputSchema` (`1/3` on Case #5, `0/3` on Case #6)**: `get_product_specs` describes hardware specifications, so on 5 of 6 runs the model repeatedly queries `search_catalog` (`"ProView 34 Ultrawide replacement power adapter"`, `"ProView power adapter"`) before falling back to `get_product_specs`.
  - **With `outputSchema` (`3/3` on Case #5, `3/3` on Case #6)**: The model sees `replacement_adapter_sku` declared in `get_product_specs.outputSchema` and resolves `PROD-10` -> `SKU-PWR-65W` directly on the first call across all 6 runs.
- **Single-Turn Profile Disambiguation (Cases #1 & #2)**:
  - **Prompts**: *"What is the sales tax exemption certificate ID on file for my account?"* (`tax_exempt_cert_id` in `get_corporate_policy`) and *"What 3-letter home airport code do I have saved on my account?"* (`home_airport_iata` in `get_loyalty_benefits`).
  - **Without `outputSchema` (`0/3` and `0/3`)**: Defaults to calling `get_user_preferences({})` first on all 6 runs.
  - **With `outputSchema` (`3/3` and `3/3`)**: Matches `tax_exempt_cert_id` and `home_airport_iata` in `outputSchema` and calls the exact tool in 1 step on all 6 runs.

---

## 3. Why a Dedicated `@google/genai` Evaluator?

While [`webmcp-evals`](https://github.com/GoogleChromeLabs/webmcp-tools/tree/main/webmcp-evals) defines `outputSchema: object | null` in `ToolSchema`, its `runLocalCommand` and Vercel AI SDK mapper (`LanguageModelV4FunctionTool`) strip `outputSchema` before sending tool declarations to the model.

This project uses the exact `schema.json` and `evals.json` formats from `webmcp-evals`, while calling `@google/genai` directly and mapping each tool's `outputSchema` to Gemini's native `FunctionDeclaration.responseJsonSchema` alongside `parametersJsonSchema`.

---

## 4. Usage

1. Copy `.env.example` to `.env` and add your Gemini API key (`GEMINI_API_KEY=...`).
2. Run unit and WebMCP schema audit tests:
   ```bash
   npm test
   ```
3. Run the side-by-side comparison (defaults to `gemini-3-flash-preview`, customizable with `-m`, `-r`, and `-f`):
   ```bash
   npm run eval:compare
   # Run 3 iterations per case:
   node dist/compare.js -r 3
   ```
4. Run a single toolset individually:
   ```bash
   npm run eval:without-output
   npm run eval:with-output
   ```
