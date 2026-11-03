/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matches an actual argument value against an expected value or constraint object.
 * Compatible with `webmcp-evals` matcher operators:
 * - `$pattern`: regex string match
 * - `$contains`: string substring or array element match
 * - `$gt`, `$gte`, `$lt`, `$lte`: numeric comparisons
 * - `$type`: primitive or array/object type check
 * - `$any`: matches any defined value
 */
export function matchesArgument(expected: unknown, actual: unknown): boolean {
  if (expected === actual) {
    return true;
  }

  if (expected === null || typeof expected !== "object") {
    return false;
  }

  if (!Array.isArray(expected)) {
    const record = expected as Record<string, unknown>;
    const keys = Object.keys(record);
    const hasOperator = keys.some((k) => k.startsWith("$"));
    if (hasOperator) {
      return evaluateOperators(record, actual);
    }
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) {
      return false;
    }
    for (let i = 0; i < expected.length; i++) {
      if (!matchesArgument(expected[i], actual[i])) {
        return false;
      }
    }
    return true;
  }

  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }

  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;

  for (const key of Object.keys(expectedObj)) {
    if (!matchesArgument(expectedObj[key], actualObj[key])) {
      return false;
    }
  }

  return true;
}

function evaluateOperators(constraints: Record<string, unknown>, actual: unknown): boolean {
  for (const [op, rule] of Object.entries(constraints)) {
    switch (op) {
      case "$any":
        if (rule === true && actual === undefined) return false;
        break;
      case "$type": {
        if (rule === "array") {
          if (!Array.isArray(actual)) return false;
        } else if (rule === "object") {
          if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
        } else if (typeof actual !== rule) {
          return false;
        }
        break;
      }
      case "$pattern": {
        if (typeof actual !== "string" || typeof rule !== "string") return false;
        const hasInlineIgnoreCase = rule.startsWith("(?i)");
        const patternSource = hasInlineIgnoreCase ? rule.slice(4) : rule;
        const regex = new RegExp(patternSource, hasInlineIgnoreCase ? "i" : "i");
        if (!regex.test(actual)) return false;
        break;
      }
      case "$contains": {
        if (typeof actual === "string") {
          if (!actual.includes(String(rule))) return false;
        } else if (Array.isArray(actual)) {
          if (!actual.some((item) => matchesArgument(rule, item))) return false;
        } else {
          return false;
        }
        break;
      }
      case "$gt":
        if (typeof actual !== "number" || typeof rule !== "number" || !(actual > rule)) {
          return false;
        }
        break;
      case "$gte":
        if (typeof actual !== "number" || typeof rule !== "number" || !(actual >= rule)) {
          return false;
        }
        break;
      case "$lt":
        if (typeof actual !== "number" || typeof rule !== "number" || !(actual < rule)) {
          return false;
        }
        break;
      case "$lte":
        if (typeof actual !== "number" || typeof rule !== "number" || !(actual <= rule)) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}
