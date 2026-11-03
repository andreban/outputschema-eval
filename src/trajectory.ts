/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

import { matchesArgument } from "./matcher.js";
import {
  ExpectedCallNode,
  ExpectedFunctionCall,
  ToolCall,
  TrajectoryComparisonItem,
} from "./types.js";

export interface MatchResult {
  matches: boolean;
  consumed: number;
  mappedResults: TrajectoryComparisonItem[];
}

export function isUnorderedGroup(
  node: ExpectedCallNode,
): node is { unordered: ExpectedCallNode[] } {
  return node !== null && typeof node === "object" && "unordered" in node;
}

export function isOrderedGroup(
  node: ExpectedCallNode,
): node is { ordered: ExpectedCallNode[] } {
  return node !== null && typeof node === "object" && "ordered" in node;
}

export function isFunctionCall(node: ExpectedCallNode): node is ExpectedFunctionCall {
  return node !== null && typeof node === "object" && "functionName" in node;
}

export function functionCallOutcome(
  expected: ExpectedFunctionCall | null,
  actual: ToolCall | null,
): "pass" | "fail" {
  if (expected === null && actual === null) return "pass";
  if (!expected || !actual) return "fail";

  if (expected.functionName !== actual.functionName) return "fail";

  if (expected.arguments != null) {
    if (!matchesArgument(expected.arguments, actual.args)) return "fail";
  }

  if (expected.result !== undefined) {
    if (!matchesArgument(expected.result, actual.result)) return "fail";
  }

  return "pass";
}

function matchSimpleUnorderedGroup(
  nodes: ExpectedCallNode[],
  executions: ToolCall[],
  startIndex: number,
): MatchResult {
  const expectedNodesCount = nodes.length;
  const executionPoolSize = Math.max(
    0,
    Math.min(expectedNodesCount, executions.length - startIndex),
  );

  const adjacencyList: number[][] = [];
  for (let i = 0; i < expectedNodesCount; i++) {
    const expected = nodes[i];
    if (!isFunctionCall(expected)) {
      throw new Error("Expected FunctionCall in simple unordered group");
    }
    const matches: number[] = [];
    for (let j = 0; j < executionPoolSize; j++) {
      if (functionCallOutcome(expected, executions[startIndex + j]) === "pass") {
        matches.push(j);
      }
    }
    adjacencyList.push(matches);
  }

  const executionToExpectedMatchMap: number[] = Array(executionPoolSize).fill(-1);

  function findAugmentingPath(expectedIndex: number, visited: boolean[]): boolean {
    for (const executionIndex of adjacencyList[expectedIndex]) {
      if (!visited[executionIndex]) {
        visited[executionIndex] = true;
        const previousExpectedMatch = executionToExpectedMatchMap[executionIndex];
        if (
          previousExpectedMatch < 0 ||
          findAugmentingPath(previousExpectedMatch, visited)
        ) {
          executionToExpectedMatchMap[executionIndex] = expectedIndex;
          return true;
        }
      }
    }
    return false;
  }

  let matchCount = 0;
  for (let i = 0; i < expectedNodesCount; i++) {
    const visited = Array(executionPoolSize).fill(false);
    if (findAugmentingPath(i, visited)) {
      matchCount++;
    }
  }

  const expectedToExecutionMatchMap: number[] = Array(expectedNodesCount).fill(-1);
  for (let j = 0; j < executionPoolSize; j++) {
    const matchedExpected = executionToExpectedMatchMap[j];
    if (matchedExpected >= 0) {
      expectedToExecutionMatchMap[matchedExpected] = j;
    }
  }

  const unmatchedExecutions: ToolCall[] = [];
  for (let j = 0; j < executionPoolSize; j++) {
    if (executionToExpectedMatchMap[j] === -1) {
      unmatchedExecutions.push(executions[startIndex + j]);
    }
  }

  const mappedResults: TrajectoryComparisonItem[] = [];
  let unmatchedIdx = 0;
  for (let i = 0; i < expectedNodesCount; i++) {
    const expected = nodes[i] as ExpectedFunctionCall;
    const matchedExecIdx = expectedToExecutionMatchMap[i];
    if (matchedExecIdx >= 0) {
      mappedResults.push({
        expected,
        actual: executions[startIndex + matchedExecIdx],
        outcome: "pass",
      });
    } else {
      const actual =
        unmatchedIdx < unmatchedExecutions.length ? unmatchedExecutions[unmatchedIdx++] : null;
      mappedResults.push({
        expected,
        actual,
        outcome: "fail",
      });
    }
  }

  return {
    matches: matchCount === expectedNodesCount,
    consumed: expectedNodesCount,
    mappedResults,
  };
}

export function matchExpectedNode(
  node: ExpectedCallNode,
  executions: ToolCall[],
  startIndex: number,
): MatchResult {
  if (isUnorderedGroup(node)) {
    return matchSimpleUnorderedGroup(node.unordered, executions, startIndex);
  }
  if (isOrderedGroup(node)) {
    return matchSequence(node.ordered, executions, startIndex);
  }
  if (isFunctionCall(node)) {
    if (startIndex >= executions.length) {
      if (node.optional) {
        return { matches: true, consumed: 0, mappedResults: [] };
      }
      return {
        matches: false,
        consumed: 1,
        mappedResults: [{ expected: node, actual: null, outcome: "fail" }],
      };
    }
    const actual = executions[startIndex];
    const outcome = functionCallOutcome(node, actual);
    if (node.optional && outcome === "fail") {
      return { matches: true, consumed: 0, mappedResults: [] };
    }
    return {
      matches: outcome === "pass",
      consumed: 1,
      mappedResults: [{ expected: node, actual, outcome }],
    };
  }
  return { matches: false, consumed: 0, mappedResults: [] };
}

export function matchSequence(
  nodes: ExpectedCallNode[],
  executions: ToolCall[],
  startIndex: number,
): MatchResult {
  let currentIndex = startIndex;
  let allMatched = true;
  const mappedResults: TrajectoryComparisonItem[] = [];

  for (const node of nodes) {
    const res = matchExpectedNode(node, executions, currentIndex);
    if (!res.matches) allMatched = false;
    currentIndex += res.consumed;
    mappedResults.push(...res.mappedResults);
  }

  return {
    matches: allMatched,
    consumed: currentIndex - startIndex,
    mappedResults,
  };
}

export function evaluateExecutionTrajectory(
  expectedCalls: ExpectedCallNode[] | null,
  executions: ToolCall[],
): TrajectoryComparisonItem[] {
  if (!expectedCalls || expectedCalls.length === 0) {
    if (executions.length === 0) {
      return expectedCalls === null ? [{ expected: null, actual: null, outcome: "pass" }] : [];
    }
    return executions.map((actual) => ({ expected: null, actual, outcome: "fail" }));
  }

  const { mappedResults, consumed } = matchSequence(expectedCalls, executions, 0);

  return [
    ...mappedResults,
    ...executions.slice(consumed).map((actual) => ({
      expected: null,
      actual,
      outcome: "fail" as const,
    })),
  ];
}
