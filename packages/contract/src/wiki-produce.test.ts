import assert from "node:assert/strict";
import { test } from "node:test";
import { WikiProduceToolDetailsSchema } from "./wiki-produce.js";

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

test("WikiProduceToolDetailsSchema rejects historical status values and page lists", () => {
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "accepted",
      pages: ["overview.md"],
    }).success,
    false,
  );

  for (const status of [
    "freezing",
    "planning",
    "awaiting_plan",
    "producing",
    "awaiting_publication",
    "published",
    "publication_declined",
  ]) {
    assert.equal(
      WikiProduceToolDetailsSchema.safeParse({ status, runId: "run-1" }).success,
      false,
      status,
    );
  }
});
