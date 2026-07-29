import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunSnapshot } from "@okf-wiki/contract";
import {
  attemptStatusFromWiki,
  failedNodesFromSnapshot,
  openGatesFromSnapshot,
  projectWikiAttempt,
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

    // Deprecated intermediate shape (tests only — product uses wikiRunToViewModel).
    const graph = wikiRunSnapshotToRunGraph(snapshot);
    assert.equal(graph.topology.length, 3);
    assert.equal(graph.topology.find((n) => n.nodeKey === "research.leaf.core")?.kind, "leaf");
    assert.equal(graph.playhead?.attemptId, "a-leaf");

    // Direct product projection (no RunGraphSnapshot hop required).
    const vm = wikiRunToViewModel(snapshot);
    assert.ok(vm.layers.some((l) => l.id === "research"));
    assert.ok(vm.layers.some((l) => l.id === "write"));
    assert.equal(vm.runState, "running");
    assert.equal(vm.revision, 3);
    assert.equal(vm.topologyVersion, 3);
    assert.equal(vm.playhead?.attemptId, "a-leaf");
    const leaf = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "research.leaf.core");
    assert.equal(leaf?.status, "running");
    assert.equal(leaf?.kind, "leaf");
    // write.root has no attempts — overlay control-plane blocked → idle.
    const write = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "write.root");
    assert.equal(write?.status, "idle");
    assert.equal(write?.attemptCount, 0);
  });

  it("overlays nodeStatusFromWiki when node has no attempts", () => {
    const snapshot = baseSnapshot({
      nodes: [
        {
          key: "gate.plan",
          kind: "gate.plan",
          state: "waiting",
          generation: 0,
          currentAttemptId: null,
          lastAttemptId: null,
          outputs: [],
          label: "Plan gate",
        },
        {
          key: "plan",
          kind: "plan",
          state: "ready",
          generation: 0,
          currentAttemptId: null,
          lastAttemptId: null,
          outputs: [],
          label: "Plan",
        },
      ],
    });
    const vm = wikiRunToViewModel(snapshot);
    const gate = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "gate.plan");
    const plan = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "plan");
    assert.equal(gate?.status, "awaiting");
    assert.equal(plan?.status, "pending");
    assert.equal(vm.attempts.length, 0);
  });

  it("projects orphan attempts as synthetic other-layer nodes", () => {
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
          label: "Plan",
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
          attemptId: "a-orphan",
          nodeKey: "ghost.orphan",
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
    const vm = wikiRunToViewModel(snapshot);
    const orphan = vm.layers.flatMap((l) => l.nodes).find((n) => n.nodeKey === "ghost.orphan");
    assert.ok(orphan);
    assert.equal(orphan?.layer, "other");
    assert.equal(orphan?.status, "running");
    assert.equal(vm.playhead?.attemptId, "a-orphan");
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
          failureClass: "infrastructure",
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

  it("maps WikiRunAttempt.failureClass to NodeAttempt.errorClass", () => {
    const projected = projectWikiAttempt({
      attemptId: "a-cap",
      nodeKey: "research.leaf.x",
      nodeGeneration: 0,
      runIndex: 1,
      state: "failed",
      inputDigest: digest,
      error: "context overflow",
      failureClass: "capacity",
      startedAt: timestamp,
      endedAt: timestamp,
    });
    assert.equal(projected.errorClass, "capacity");
    assert.equal(projected.summary, "context overflow");
    assert.equal(projected.status, "error");

    // provider/cancelled are Pi classes, not ErrorClass — omit rather than invent.
    const provider = projectWikiAttempt({
      attemptId: "a-prov",
      nodeKey: "research.leaf.x",
      nodeGeneration: 0,
      runIndex: 2,
      state: "failed",
      inputDigest: digest,
      error: "auth",
      failureClass: "provider",
      startedAt: timestamp,
      endedAt: timestamp,
    });
    assert.equal(provider.errorClass, undefined);
  });
});
