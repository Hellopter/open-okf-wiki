import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolDetailsAccumulator } from "./wiki-produce-details.js";

test("createToolDetailsAccumulator applies status; attempt/topology are graph no-ops", () => {
  const acc = createToolDetailsAccumulator({ status: "freezing", runId: "r1" });
  assert.equal(acc.details.status, "freezing");
  assert.equal(acc.details.runId, "r1");

  acc.apply({ kind: "status", status: "producing", summary: "working" });
  assert.equal(acc.details.status, "producing");
  assert.equal(acc.details.summary, "working");

  // attempt/topology must not dual-upsert graph (owner is sole authority).
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
  assert.ok(!("graph" in acc.details && acc.details.graph));

  acc.apply({
    kind: "topology",
    topology: [{ nodeKey: "plan", kind: "plan", label: "Plan" }],
    topologyVersion: 1,
  });
  assert.ok(!("graph" in acc.details && acc.details.graph));

  // Whole-graph replace from owner snapshot.
  acc.apply({
    kind: "graph",
    graph: {
      topologyVersion: 1,
      topology: [{ nodeKey: "domain-1", kind: "domain", label: "D" }],
      attempts: [
        {
          attemptId: "domain-1",
          nodeKey: "domain-1",
          runIndex: 0,
          role: "domain",
          status: "running",
          summary: "research",
        },
      ],
      playhead: { nodeKey: "domain-1", attemptId: "domain-1" },
    },
  });
  assert.equal(acc.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts[0]?.attemptId, "domain-1");
  assert.equal(acc.details.graph?.playhead?.attemptId, "domain-1");

  acc.apply({
    kind: "graph",
    graph: {
      topologyVersion: 1,
      topology: [{ nodeKey: "domain-1", kind: "domain", label: "D" }],
      attempts: [
        {
          attemptId: "domain-1",
          nodeKey: "domain-1",
          runIndex: 0,
          role: "domain",
          status: "done",
          summary: "done",
        },
      ],
      playhead: { nodeKey: "domain-1", attemptId: "domain-1" },
    },
  });
  assert.equal(acc.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts[0]?.status, "done");

  const snap = acc.toPartial();
  assert.equal(snap.details.status, "producing");
  assert.ok(Array.isArray(snap.content));
  // Snapshot must not share the live attempts array.
  acc.apply({
    kind: "graph",
    graph: {
      topologyVersion: 1,
      topology: [],
      attempts: [
        {
          attemptId: "domain-1",
          nodeKey: "domain-1",
          runIndex: 0,
          role: "domain",
          status: "done",
        },
        {
          attemptId: "leaf-1",
          nodeKey: "leaf-1",
          runIndex: 0,
          role: "leaf",
          status: "running",
        },
      ],
    },
  });
  assert.equal(snap.details.graph?.attempts.length, 1);
  assert.equal(acc.details.graph?.attempts.length, 2);
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

test("graph replace clones topology and attempts", () => {
  const acc = createToolDetailsAccumulator();
  const topology = [{ nodeKey: "plan", kind: "plan" as const, label: "Plan" }];
  const attempts = [
    {
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      role: "plan" as const,
      status: "done" as const,
    },
  ];
  acc.apply({
    kind: "graph",
    graph: { topologyVersion: 1, topology, attempts },
  });
  topology.push({ nodeKey: "write", kind: "plan", label: "W" });
  attempts.push({
    attemptId: "w",
    nodeKey: "write",
    runIndex: 0,
    role: "plan",
    status: "done",
  });
  assert.equal(acc.details.graph?.topology.length, 1);
  assert.equal(acc.details.graph?.attempts.length, 1);
});
