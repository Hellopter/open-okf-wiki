import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "./run.js";
import { emptyRunGraphSnapshot } from "./run-graph.js";
import {
  projectWikiProduceDetailsForHistory,
  toDurableWikiProduceDetails,
  WikiProduceDurableDetailsSchema,
  WikiProduceToolDetailsSchema,
} from "./wiki-produce.js";

test("WikiProduceToolDetailsSchema exposes only stable Run and gate facts", () => {
  const details = WikiProduceToolDetailsSchema.parse({
    status: "awaiting_plan",
    runId: "run-1",
    spec: defaultWikiRunSpec("demo"),
    pages: [],
    summary: "Awaiting WikiRunSpec approval",
    defects: null,
  });
  assert.equal(details.status, "awaiting_plan");
  assert.equal(details.spec?.pages.length, 1);
});

test("WikiProduceToolDetailsSchema accepts optional graph projection", () => {
  const details = WikiProduceToolDetailsSchema.parse({
    status: "planning",
    runId: "run-1",
    summary: "Planning WikiRunSpec",
    graph: {
      topologyVersion: 1,
      topology: [{ nodeKey: "plan", kind: "plan", label: "Plan" }],
      attempts: [
        {
          attemptId: "plan-0",
          nodeKey: "plan",
          runIndex: 0,
          role: "plan",
          status: "running",
          summary: "Inspecting sources…",
          items: [
            { type: "text", text: "Looking at sources/main" },
            { type: "toolCall", name: "ls", argsSummary: "sources/", status: "done" },
          ],
          usage: { turns: 1, contextTokens: 1200 },
        },
      ],
      playhead: { nodeKey: "plan", attemptId: "plan-0" },
    },
  });
  assert.equal(details.graph?.attempts[0]?.role, "plan");
  assert.equal(details.graph?.attempts[0]?.items?.length, 2);
});

test("WikiProduceToolDetailsSchema rejects children (removed live field)", () => {
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "planning",
      children: [{ id: "plan", role: "plan", status: "done" }],
    }).success,
    false,
  );
});

test("WikiProduceToolDetailsSchema rejects duplicate Pi framing and phase", () => {
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "planning",
      toolCallId: "call-1",
    }).success,
    false,
  );
  assert.equal(
    WikiProduceToolDetailsSchema.safeParse({
      status: "planning",
      phase: "planning",
    }).success,
    false,
  );
});

test("toDurableWikiProduceDetails strips live-only Run mirrors", () => {
  const live = WikiProduceToolDetailsSchema.parse({
    status: "published",
    runId: "run-1",
    spec: defaultWikiRunSpec("demo"),
    pages: ["overview.md", "architecture.md"],
    summary: "Published",
    defects: { version: 1, clean: true, defects: [], reviewerIds: [] },
    graph: {
      ...emptyRunGraphSnapshot(1),
      topology: [{ nodeKey: "plan", kind: "plan", label: "Plan" }],
      attempts: [
        {
          attemptId: "plan-0",
          nodeKey: "plan",
          runIndex: 0,
          role: "plan",
          status: "done",
          summary: "done",
        },
      ],
    },
  });
  const durable = toDurableWikiProduceDetails(live);
  assert.deepEqual(durable, {
    status: "published",
    runId: "run-1",
    pages: ["overview.md", "architecture.md"],
    summary: "Published",
  });
  assert.equal("spec" in durable, false);
  assert.equal("graph" in durable, false);
  assert.equal("defects" in durable, false);
  WikiProduceDurableDetailsSchema.parse(durable);
  WikiProduceToolDetailsSchema.parse(durable);
});

test("projectWikiProduceDetailsForHistory strips fat fields without rewriting non-wiki details", () => {
  const fat = {
    status: "published",
    runId: "run-1",
    summary: "ok",
    pages: ["overview.md"],
    spec: defaultWikiRunSpec("demo"),
    graph: emptyRunGraphSnapshot(1),
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
