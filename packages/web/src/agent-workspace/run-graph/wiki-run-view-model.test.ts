import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunSnapshot } from "@okf-wiki/contract";
import {
  attemptStatusFromWiki,
  failedNodesFromSnapshot,
  openGatesFromSnapshot,
  wikiRunSnapshotToRunGraph,
  wikiRunToViewModel,
} from "./wiki-run-view-model.ts";

const timestamp = "2026-07-28T00:00:00.000Z";
const digest = "a".repeat(64);

function baseSnapshot(partial: Partial<WikiRunSnapshot> = {}): WikiRunSnapshot {
  return {
    schema: "okf.wiki-runs/v1",
    definitionVersion: 1,
    runId: "run-1",
    workspaceId: "ws-1",
    revision: 3,
    state: "running",
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

describe("wikiRun view-model projection", () => {
  it("maps node kinds into layered RunGraph topology", () => {
    const snapshot = baseSnapshot({
      nodes: [
        {
          key: "plan",
          kind: "plan",
          state: "succeeded",
          generation: 0,
          currentAttemptId: null,
          lastAttemptId: "a-plan",
          outputs: [],
            label: "node",
        },
        {
          key: "research.leaf.core",
          kind: "research.leaf",
          state: "running",
          generation: 0,
          currentAttemptId: "a-leaf",
          lastAttemptId: "a-leaf",
          outputs: [],
            label: "node",
        },
        {
          key: "write.root",
          kind: "write.root",
          state: "blocked",
          generation: 0,
          currentAttemptId: null,
          lastAttemptId: null,
          outputs: [],
            label: "node",
        },
      ],
      attempts: [
        {
          attemptId: "a-plan",
          nodeKey: "plan",
          nodeGeneration: 0,
          runIndex: 1,
          state: "succeeded",
          inputDigest: digest,
          error: null,
          startedAt: timestamp,
          endedAt: timestamp,
        },
        {
          attemptId: "a-leaf",
          nodeKey: "research.leaf.core",
          nodeGeneration: 0,
          runIndex: 2,
          state: "running",
          inputDigest: digest,
          error: null,
          startedAt: timestamp,
          endedAt: null,
        },
      ],
    });

    const graph = wikiRunSnapshotToRunGraph(snapshot);
    assert.equal(graph.topology.length, 3);
    assert.equal(graph.topology.find((n) => n.nodeKey === "research.leaf.core")?.kind, "leaf");
    assert.equal(graph.playhead?.attemptId, "a-leaf");

    const vm = wikiRunToViewModel(snapshot);
    assert.ok(vm.layers.some((l) => l.id === "research"));
    assert.ok(vm.layers.some((l) => l.id === "write"));
    assert.equal(vm.runState, "running");
    assert.equal(vm.revision, 3);
    const leaf = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "research.leaf.core");
    assert.equal(leaf?.status, "running");
  });

  it("collects open gates and failed retry targets", () => {
    const snapshot = baseSnapshot({
      state: "waiting_for_operator",
      nodes: [
        {
          key: "gate.plan",
          kind: "gate.plan",
          state: "waiting",
          generation: 0,
          currentAttemptId: null,
          lastAttemptId: null,
          outputs: [],
            label: "node",
        },
        {
          key: "research.leaf.x",
          kind: "research.leaf",
          state: "failed",
          generation: 1,
          currentAttemptId: "a-fail",
          lastAttemptId: "a-fail",
          outputs: [],
            label: "node",
        },
      ],
      attempts: [
        {
          attemptId: "a-fail",
          nodeKey: "research.leaf.x",
          nodeGeneration: 1,
          runIndex: 3,
          state: "failed",
          inputDigest: digest,
          error: "provider timeout",
          startedAt: timestamp,
          endedAt: timestamp,
        },
      ],
      gates: [
        {
          gateId: "g-plan",
          nodeKey: "gate.plan",
          nodeGeneration: 0,
          kind: "plan",
          state: "open",
          payloadDigest: digest,
          decision: null,
          openedAt: timestamp,
        },
        {
          gateId: "g-old",
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
    });

    assert.equal(openGatesFromSnapshot(snapshot).length, 1);
    assert.equal(openGatesFromSnapshot(snapshot)[0]?.gateId, "g-plan");

    const failed = failedNodesFromSnapshot(snapshot);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.attempt.attemptId, "a-fail");
    assert.equal(failed[0]?.node.generation, 1);

    const vm = wikiRunToViewModel(snapshot);
    assert.equal(vm.openGates.length, 1);
    assert.equal(vm.failedNodes.length, 1);
  });

  it("maps attempt states to canvas statuses", () => {
    assert.equal(attemptStatusFromWiki("succeeded"), "done");
    assert.equal(attemptStatusFromWiki("interrupted"), "error");
    assert.equal(attemptStatusFromWiki("suspended"), "awaiting");
  });
});
