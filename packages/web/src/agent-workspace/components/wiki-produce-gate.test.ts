/**
 * Durable WikiRuns gate helpers — open gates / failed nodes drive HITL,
 * not Session memory pendingGate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunSnapshot } from "@okf-wiki/contract";
import {
  failedNodesFromSnapshot,
  openGatesFromSnapshot,
} from "../run-graph/wiki-run-view-model.ts";

const timestamp = "2026-07-28T00:00:00.000Z";
const digest = "b".repeat(64);

function snapshot(partial: Partial<WikiRunSnapshot> = {}): WikiRunSnapshot {
  return {
    schema: "okf.wiki-runs/v1",
    definitionVersion: 1,
    runId: "run-1",
    workspaceId: "ws-1",
    revision: 1,
    state: "waiting_for_operator",
    cancelRequested: false,
    pinnedInputs: null,
    nodes: [],
    attempts: [],
    gates: [],
    effects: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...partial,
  };
}

describe("wiki_produce gate interactivity (WikiRuns snapshot)", () => {
  it("open plan gate is interactive source for Approve/Deny", () => {
    const open = openGatesFromSnapshot(
      snapshot({
        gates: [
          {
            gateId: "g1",
            nodeKey: "gate.plan",
            nodeGeneration: 0,
            kind: "plan",
            state: "open",
            payloadDigest: digest,
            decision: null,
            openedAt: timestamp,
          },
        ],
      }),
    );
    assert.equal(open.length, 1);
    assert.equal(open[0]?.kind, "plan");
  });

  it("open fix gate is interactive source for Pass/Fix/Revise/Deny", () => {
    const open = openGatesFromSnapshot(
      snapshot({
        gates: [
          {
            gateId: "g-fix",
            nodeKey: "gate.fix",
            nodeGeneration: 0,
            kind: "fix",
            state: "open",
            payloadDigest: digest,
            decision: null,
            openedAt: timestamp,
          },
        ],
      }),
    );
    assert.equal(open.length, 1);
    assert.equal(open[0]?.kind, "fix");
  });

  it("resolved gates are not interactive", () => {
    const open = openGatesFromSnapshot(
      snapshot({
        gates: [
          {
            gateId: "g1",
            nodeKey: "gate.plan",
            nodeGeneration: 0,
            kind: "plan",
            state: "resolved",
            payloadDigest: digest,
            decision: {
              commandId: "c1",
              decision: "approve",
              payloadDigest: digest,
              decidedAt: timestamp,
            },
            openedAt: timestamp,
          },
        ],
      }),
    );
    assert.equal(open.length, 0);
  });

  it("failed node with matching generation is a RetryFailedNode target", () => {
    const failed = failedNodesFromSnapshot(
      snapshot({
        state: "running",
        nodes: [
          {
            key: "research.leaf.x",
            kind: "research.leaf",
            state: "failed",
            generation: 2,
            currentAttemptId: "a1",
            lastAttemptId: "a1",
            outputs: [],
            label: "node",
          },
        ],
        attempts: [
          {
            attemptId: "a1",
            nodeKey: "research.leaf.x",
            nodeGeneration: 2,
            runIndex: 1,
            state: "failed",
            inputDigest: digest,
            error: "boom",
            startedAt: timestamp,
            endedAt: timestamp,
          },
        ],
      }),
    );
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.node.generation, 2);
    assert.equal(failed[0]?.attempt.attemptId, "a1");
  });

  it("stale attempt generation is not a retry target", () => {
    const failed = failedNodesFromSnapshot(
      snapshot({
        nodes: [
          {
            key: "research.leaf.x",
            kind: "research.leaf",
            state: "failed",
            generation: 3,
            currentAttemptId: "a-old",
            lastAttemptId: "a-old",
            outputs: [],
            label: "node",
          },
        ],
        attempts: [
          {
            attemptId: "a-old",
            nodeKey: "research.leaf.x",
            nodeGeneration: 1,
            runIndex: 1,
            state: "failed",
            inputDigest: digest,
            error: "stale",
            startedAt: timestamp,
            endedAt: timestamp,
          },
        ],
      }),
    );
    assert.equal(failed.length, 0);
  });
});
