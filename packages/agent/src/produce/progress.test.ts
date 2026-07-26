import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyRunGraphSnapshot } from "@okf-wiki/contract";
import { createToolDetailsAccumulator, upsertAttempt } from "./progress.js";

test("createToolDetailsAccumulator applies status and attempt patches", () => {
  const acc = createToolDetailsAccumulator({ status: "freezing", runId: "r1" });
  assert.equal(acc.details.status, "freezing");
  assert.equal(acc.details.runId, "r1");

  acc.apply({ kind: "status", status: "producing", summary: "working" });
  assert.equal(acc.details.status, "producing");
  assert.equal(acc.details.summary, "working");

  acc.apply({
    kind: "attempt",
    attempt: {
      attemptId: "domain-1",
      nodeKey: "domain-1",
      runIndex: 0,
      role: "domain",
      status: "running",
      summary: "research",
    },
  });
  assert.equal(acc.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts[0]?.attemptId, "domain-1");
  assert.equal(acc.details.graph?.playhead?.attemptId, "domain-1");

  // Same attemptId updates in place (streaming).
  acc.apply({
    kind: "attempt",
    attempt: {
      attemptId: "domain-1",
      nodeKey: "domain-1",
      runIndex: 0,
      role: "domain",
      status: "done",
      summary: "done",
    },
  });
  assert.equal(acc.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts[0]?.status, "done");

  const snap = acc.toPartial();
  assert.equal(snap.details.status, "producing");
  assert.ok(Array.isArray(snap.content));
  // Snapshot must not share the live attempts array.
  acc.apply({
    kind: "attempt",
    attempt: {
      attemptId: "leaf-1",
      nodeKey: "leaf-1",
      runIndex: 0,
      role: "leaf",
      status: "running",
    },
  });
  assert.equal(snap.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts.length, 2);
});

test("upsertAttempt appends new attemptIds for the same nodeKey (multi-round)", () => {
  let graph = emptyRunGraphSnapshot(1);
  graph = upsertAttempt(graph, {
    attemptId: "review-0",
    nodeKey: "review",
    runIndex: 0,
    role: "reviewer",
    status: "done",
  });
  graph = upsertAttempt(graph, {
    attemptId: "review-1",
    nodeKey: "review",
    runIndex: 1,
    role: "reviewer",
    status: "running",
  });
  assert.equal(graph.attempts.length, 2);
  assert.equal(graph.attempts[1]?.runIndex, 1);
});

test("createToolDetailsAccumulator projects pages/spec/defects/runId", () => {
  const acc = createToolDetailsAccumulator();
  acc.apply({ kind: "runId", runId: "run-x" });
  acc.apply({ kind: "pages", pages: ["overview.md"] });
  acc.apply({
    kind: "defects",
    defects: {
      version: 1,
      clean: true,
      defects: [],
      reviewerIds: ["r1"],
      summary: "NO_DEFECTS",
    },
    summary: "clean",
  });
  assert.equal(acc.details.runId, "run-x");
  assert.deepEqual(acc.details.pages, ["overview.md"]);
  assert.equal(acc.details.defects?.clean, true);
  assert.equal(acc.details.summary, "clean");
});

test("topology progress sets topology without wiping attempts", () => {
  const acc = createToolDetailsAccumulator();
  acc.apply({
    kind: "attempt",
    attempt: {
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      role: "plan",
      status: "done",
    },
  });
  acc.apply({
    kind: "topology",
    topology: [
      { nodeKey: "plan", kind: "plan", label: "Plan" },
      { nodeKey: "domain-core", kind: "domain", label: "Core", parentKey: "plan" },
    ],
    topologyVersion: 1,
  });
  assert.equal(acc.details.graph?.topology.length, 2);
  assert.equal(acc.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts[0]?.attemptId, "plan");
  assert.equal(acc.details.graph?.topologyVersion, 1);
});
