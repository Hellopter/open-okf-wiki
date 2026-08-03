import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatContextFill } from "@okf-wiki/contract/session";
import type { WikiRunAttempt } from "@okf-wiki/contract/wiki-runs";
import {
  contextPhaseFromAttemptUsage,
  formatAttemptTokenSideNote,
  formatNodeContextHoverTitle,
  isCapacityFailure,
  latestAttemptOnNode,
  nodeContextFillSummary,
  sessionUsageFromAttempt,
  stageContextFillSummary,
  usageFieldsFromMetricsExtra,
} from "./attempt-usage.ts";

function attempt(partial: Partial<WikiRunAttempt> & Pick<WikiRunAttempt, "attemptId" | "nodeKey">): WikiRunAttempt {
  return {
    nodeGeneration: 0,
    runIndex: 1,
    state: "succeeded",
    inputDigest: "a".repeat(64),
    error: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    ...partial,
  };
}

describe("sessionUsageFromAttempt", () => {
  it("maps metrics.inputTokens to contextTokens", () => {
    const usage = sessionUsageFromAttempt({
      metrics: { inputTokens: 12_400, outputTokens: 200, modelId: "gpt-test" },
    });
    assert.deepEqual(usage, { contextTokens: 12_400 });
  });

  it("prefers metrics.inputTokens over usage.contextTokens", () => {
    const usage = sessionUsageFromAttempt(
      { metrics: { inputTokens: 100 } },
      { contextTokens: 999, contextWindow: 128_000 },
    );
    assert.equal(usage?.contextTokens, 100);
    assert.equal(usage?.contextWindow, 128_000);
  });

  it("falls back to usage.contextTokens when metrics missing", () => {
    const usage = sessionUsageFromAttempt(null, {
      contextTokens: 50,
      contextTarget: 1000,
    });
    assert.deepEqual(usage, { contextTokens: 50, contextTarget: 1000 });
  });

  it("reads window/target from metrics.extra", () => {
    const usage = sessionUsageFromAttempt({
      metrics: {
        inputTokens: 80,
        extra: { contextWindow: 128_000, contextTarget: 100_000 },
      },
    });
    assert.equal(usage?.contextTokens, 80);
    assert.equal(usage?.contextWindow, 128_000);
    assert.equal(usage?.contextTarget, 100_000);
  });

  it("metrics.extra window/target yield percent not tokens_only", () => {
    const usage = sessionUsageFromAttempt({
      metrics: {
        inputTokens: 64_000,
        extra: { contextWindow: 128_000, contextTarget: 108_800 },
      },
    });
    const view = formatContextFill(usage);
    assert.ok(view);
    assert.equal(view.denomKind, "window");
    assert.equal(view.percent, 50);
    assert.match(view.label, /64k/);
    assert.match(view.label, /128k/);
  });

  it("tokens without metrics.extra stay tokens_only", () => {
    const usage = sessionUsageFromAttempt({
      metrics: { inputTokens: 12_400 },
    });
    const view = formatContextFill(usage);
    assert.ok(view);
    assert.equal(view.denomKind, "tokens_only");
    assert.equal(view.percent, null);
  });

  it("returns undefined when nothing useful", () => {
    assert.equal(sessionUsageFromAttempt({ metrics: { role: "plan" } }), undefined);
    assert.equal(sessionUsageFromAttempt(null), undefined);
  });
});

describe("usageFieldsFromMetricsExtra", () => {
  it("ignores non-positive values", () => {
    assert.equal(
      usageFieldsFromMetricsExtra({
        extra: { contextWindow: 0, contextTarget: -1 },
      }),
      undefined,
    );
  });
});

describe("formatAttemptTokenSideNote", () => {
  it("formats in/out/tools fragments", () => {
    const note = formatAttemptTokenSideNote(
      { inputTokens: 12_400, outputTokens: 800, toolCalls: 3 },
      {
        in: (n) => `in ${n}`,
        out: (n) => `out ${n}`,
        tools: (n) => `tools ${n}`,
      },
    );
    assert.equal(note?.label, "in 12.4k · out 800 · tools 3");
  });

  it("returns null when empty", () => {
    assert.equal(
      formatAttemptTokenSideNote({ role: "plan" }, {
        in: (n) => n,
        out: (n) => n,
        tools: (n) => n,
      }),
      null,
    );
  });
});

describe("isCapacityFailure", () => {
  it("detects failureClass capacity", () => {
    assert.equal(isCapacityFailure("capacity", null), true);
  });

  it("detects capacity message patterns", () => {
    assert.equal(isCapacityFailure(undefined, "prompt is too long for the model"), true);
    assert.equal(isCapacityFailure("schema", "invalid json"), false);
  });
});

describe("latestAttemptOnNode / nodeContextFillSummary", () => {
  const attempts = [
    attempt({
      attemptId: "a1",
      nodeKey: "plan",
      nodeGeneration: 0,
      runIndex: 1,
      metrics: { inputTokens: 100, modelId: "m1" },
    }),
    attempt({
      attemptId: "a2",
      nodeKey: "plan",
      nodeGeneration: 1,
      runIndex: 1,
      metrics: { inputTokens: 50_000, modelId: "m2", outputTokens: 10, toolCalls: 1 },
    }),
    attempt({
      attemptId: "b1",
      nodeKey: "leaf",
      metrics: { inputTokens: 1 },
    }),
  ];

  it("picks highest generation/runIndex", () => {
    assert.equal(latestAttemptOnNode(attempts, "plan")?.attemptId, "a2");
  });

  it("builds graph summary with fill label", () => {
    const summary = nodeContextFillSummary(attempts, "plan", {
      in: (n) => `in ${n}`,
      out: (n) => `out ${n}`,
      tools: (n) => `tools ${n}`,
    });
    assert.ok(summary);
    assert.equal(summary.modelId, "m2");
    assert.equal(summary.fillLabel, "50k");
    assert.match(summary.sideNote ?? "", /in 50k/);
    assert.equal(summary.phase, "unknown");
  });

  it("formats hover title", () => {
    const summary = nodeContextFillSummary(attempts, "plan");
    const title = formatNodeContextHoverTitle("Plan", summary);
    assert.match(title, /Plan/);
    assert.match(title, /m2/);
    assert.match(title, /50k/);
  });
});

describe("stageContextFillSummary", () => {
  it("prefers running node fill over higher idle fill", () => {
    const attempts = [
      attempt({
        attemptId: "idle",
        nodeKey: "a",
        metrics: {
          inputTokens: 90_000,
          extra: { contextWindow: 100_000 },
        },
      }),
      attempt({
        attemptId: "run",
        nodeKey: "b",
        metrics: {
          inputTokens: 40_000,
          extra: { contextWindow: 100_000 },
        },
      }),
    ];
    const summary = stageContextFillSummary(attempts, [
      { key: "a", state: "succeeded" },
      { key: "b", state: "running" },
    ]);
    assert.ok(summary);
    assert.equal(summary.percent, 40);
  });

  it("picks max fill when no running node has fill", () => {
    const attempts = [
      attempt({
        attemptId: "low",
        nodeKey: "a",
        metrics: {
          inputTokens: 10_000,
          extra: { contextWindow: 100_000 },
        },
      }),
      attempt({
        attemptId: "high",
        nodeKey: "b",
        metrics: {
          inputTokens: 70_000,
          extra: { contextWindow: 100_000 },
        },
      }),
    ];
    const summary = stageContextFillSummary(attempts, [
      { key: "a", state: "succeeded" },
      { key: "b", state: "succeeded" },
    ]);
    assert.ok(summary);
    assert.equal(summary.percent, 70);
  });
});

describe("contextPhaseFromAttemptUsage", () => {
  it("derives approaching when near target", () => {
    assert.equal(
      contextPhaseFromAttemptUsage({ contextTokens: 85, contextTarget: 100 }),
      "approaching_target",
    );
  });
});
