import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlReturnSchema,
  emptyRunGraphSnapshot,
  NodeAttemptSchema,
  RunGraphSnapshotSchema,
} from "./run-graph.js";

test("emptyRunGraphSnapshot is valid", () => {
  const snap = emptyRunGraphSnapshot(0);
  assert.deepEqual(RunGraphSnapshotSchema.parse(snap), snap);
});

test("RunGraphSnapshot accepts topology + append-only attempts", () => {
  const snap = RunGraphSnapshotSchema.parse({
    topologyVersion: 1,
    topology: [
      { nodeKey: "plan", kind: "plan", label: "Plan" },
      { nodeKey: "domain:auth", kind: "domain", label: "Auth", dependsOn: ["plan"] },
      {
        nodeKey: "leaf:auth:1",
        kind: "leaf",
        label: "Q1",
        parentKey: "domain:auth",
      },
      { nodeKey: "write", kind: "write", label: "Write" },
      { nodeKey: "review", kind: "review", label: "Review" },
      { nodeKey: "repair", kind: "repair", label: "Repair" },
    ],
    attempts: [
      {
        attemptId: "a1",
        nodeKey: "plan",
        runIndex: 0,
        role: "plan",
        status: "done",
        summary: "Spec ready",
      },
      {
        attemptId: "a2",
        nodeKey: "review",
        runIndex: 0,
        role: "reviewer",
        status: "done",
        summary: "3 blocking",
      },
      {
        attemptId: "a3",
        nodeKey: "repair",
        runIndex: 0,
        role: "repair",
        status: "done",
      },
      {
        attemptId: "a4",
        nodeKey: "review",
        runIndex: 1,
        role: "reviewer",
        status: "running",
      },
    ],
    playhead: { nodeKey: "review", attemptId: "a4" },
  });
  assert.equal(snap.attempts.filter((a) => a.nodeKey === "review").length, 2);
  assert.equal(snap.playhead?.attemptId, "a4");
});

test("NodeAttempt rejects empty attemptId", () => {
  assert.equal(
    NodeAttemptSchema.safeParse({
      attemptId: "",
      nodeKey: "plan",
      runIndex: 0,
      status: "running",
    }).success,
    false,
  );
});

test("ControlReturn is a short handoff envelope", () => {
  const ret = ControlReturnSchema.parse({
    attemptId: "a1",
    nodeKey: "leaf:auth:1",
    role: "leaf",
    status: "complete",
    summary: "Found auth middleware",
    receiptPath: "analysis/receipts/leaf-auth-1.json",
  });
  assert.equal(ret.status, "complete");
  assert.ok(ret.receiptPath);
});
