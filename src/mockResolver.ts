/**
 * Copyright 2026 Andre Cipriani Bandarra
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExpectedCallNode, ExpectedFunctionCall } from "./types.js";
import { isFunctionCall, isOrderedGroup, isUnorderedGroup } from "./trajectory.js";

/**
 * Resolves stub tool-result payloads for a single test case's local multi-step run,
 * matching `webmcp-evals`'s `MockResolver`.
 */
export class MockResolver {
  private readonly flat: ExpectedFunctionCall[];
  private readonly consumed: boolean[];

  constructor(expected: ExpectedCallNode[] | null) {
    this.flat = expected ? flattenTrajectory(expected) : [];
    this.consumed = Array.from({ length: this.flat.length }, () => false);
  }

  resolve(functionName: string, _args?: Record<string, unknown>): unknown {
    for (let i = 0; i < this.flat.length; i++) {
      if (this.consumed[i]) continue;
      if (this.flat[i].functionName !== functionName) continue;

      this.consumed[i] = true;
      const { mockOutput } = this.flat[i];
      return mockOutput === undefined ? {} : mockOutput;
    }
    return {};
  }
}

function flattenTrajectory(nodes: ExpectedCallNode[]): ExpectedFunctionCall[] {
  const out: ExpectedFunctionCall[] = [];
  for (const node of nodes) {
    if (isFunctionCall(node)) {
      out.push(node);
    } else if (isOrderedGroup(node)) {
      out.push(...flattenTrajectory(node.ordered));
    } else if (isUnorderedGroup(node)) {
      out.push(...flattenTrajectory(node.unordered));
    }
  }
  return out;
}
