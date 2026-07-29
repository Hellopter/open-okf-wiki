import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectWikiProduceDetailsForHistory,
  toDurableWikiProduceDetails,
  WikiProduceDurableDetailsSchema,
  WikiProduceToolDetailsSchema,
} from "./wiki-produce.js";

test("WikiProduceToolDetailsSchema is receipt-oriented (status + runId + summary)", () => {
  const details = WikiProduceToolDetailsSchema.parse({
    status: "accepted",
    runId: "run-1",
    summary: "Wiki Run accepted (revision 1).",
  });
  assert.equal(details.status, "accepted");
  assert.equal(details.runId, "run-1");
});

test("WikiProduceToolDetailsSchema rejects fat control mirrors", () => {
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      runId: "run-1",
      spec: { version: 1 },
    }).success,
    false,
  );
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      graph: { topologyVersion: 1, topology: [], attempts: [] },
    }).success,
    false,
  );
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      defects: null,
    }).success,
    false,
  );
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      children: [{ id: "plan" }],
    }).success,
    false,
  );
});

test("WikiProduceToolDetailsSchema rejects duplicate Pi framing fields", () => {
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      toolCallId: "call-1",
    }).success,
    false,
  );
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      phase: "planning",
    }).success,
    false,
  );
});

test("toDurableWikiProduceDetails is identity on receipt rows", () => {
  const live = WikiProduceToolDetailsSchema.parse({
    status: "accepted",
    runId: "run-1",
    pages: ["overview.md"],
    summary: "Wiki Run accepted",
  });
  const durable = toDurableWikiProduceDetails(live);
  assert.deepEqual(durable, {
    status: "accepted",
    runId: "run-1",
    pages: ["overview.md"],
    summary: "Wiki Run accepted",
  });
  WikiProduceDurableDetailsSchema.parse(durable);
});

test("projectWikiProduceDetailsForHistory strips fat fields from legacy rows", () => {
  const fat = {
    status: "published",
    runId: "run-1",
    summary: "ok",
    pages: ["overview.md"],
    spec: { version: 1 },
    graph: { topologyVersion: 1, topology: [], attempts: [] },
    children: [{ id: "plan", role: "plan", status: "done" }],
    defects: null,
  };
  const projected = projectWikiProduceDetailsForHistory(fat) as Record<string, unknown>;
  assert.equal(projected.status, "published");
  assert.equal(projected.runId, "run-1");
  assert.equal("spec" in projected, false);
  assert.equal("graph" in projected, false);
  assert.equal("children" in projected, false);
  assert.equal("defects" in projected, false);
  const other = { path: "/tmp/x", bytes: 12 };
  assert.equal(projectWikiProduceDetailsForHistory(other), other);
});
