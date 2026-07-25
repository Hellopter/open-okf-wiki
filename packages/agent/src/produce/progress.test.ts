import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolDetailsAccumulator } from "./progress.js";

test("createToolDetailsAccumulator applies status and children patches", () => {
  const acc = createToolDetailsAccumulator({ status: "freezing", runId: "r1" });
  assert.equal(acc.details.status, "freezing");
  assert.equal(acc.details.runId, "r1");

  acc.apply({ kind: "status", status: "producing", summary: "working" });
  assert.equal(acc.details.status, "producing");
  assert.equal(acc.details.summary, "working");

  acc.apply({
    kind: "child",
    span: {
      id: "domain-1",
      role: "domain",
      status: "running",
      summary: "research",
    },
  });
  assert.equal(acc.details.children?.length, 1);
  assert.equal(acc.details.children?.[0]?.id, "domain-1");

  acc.apply({
    kind: "child",
    span: {
      id: "domain-1",
      role: "domain",
      status: "done",
      summary: "done",
    },
  });
  assert.equal(acc.details.children?.length, 1);
  assert.equal(acc.details.children?.[0]?.status, "done");

  const snap = acc.toPartial();
  assert.equal(snap.details.status, "producing");
  assert.ok(Array.isArray(snap.content));
  // Snapshot must not share the live children array.
  acc.apply({
    kind: "child",
    span: { id: "leaf-1", role: "leaf", status: "running" },
  });
  assert.equal(snap.details.children?.length, 1);
  assert.equal(acc.details.children?.length, 2);
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
