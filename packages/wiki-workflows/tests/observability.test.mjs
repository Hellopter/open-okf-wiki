import assert from "node:assert/strict";
import test from "node:test";
import {
  activitySemantics,
  agentStatusSemantics,
  batchStatusSemantics,
  projectWikiRunEvent,
  projectWikiRunObservability,
  runStatusSemantics,
  wikiTaskClusterLabel,
} from "../dist/observability.js";

const now = Date.parse("2026-08-15T00:02:00.000Z");

function run(overrides = {}) {
  return {
    id: "run-1", cwd: "/repo", status: "running",
    createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:02:00.000Z",
    lastEventSequence: 3,
    ...overrides,
  };
}

function lead(overrides = {}) {
  return {
    target: { kind: "lead" }, role: "lead", status: "running", attempt: 1,
    activity: "delegating", activeTools: [], health: "healthy",
    lastActivityAt: "2026-08-15T00:01:57.000Z",
    lastHeartbeatAt: "2026-08-15T00:01:59.000Z",
    usage: { turns: 8, contextTokens: 800, contextWindow: 1000, contextPercent: 80 },
    ...overrides,
  };
}

test("status, agent, batch, and activity share one marker and tone matrix", () => {
  assert.deepEqual(runStatusSemantics("succeeded"), { marker: "✓", tone: "success", terminal: true });
  assert.deepEqual(runStatusSemantics("paused"), { marker: "⏸", tone: "warning", terminal: false });
  assert.deepEqual(agentStatusSemantics("retrying"), { marker: "◐", tone: "warning", terminal: false });
  assert.deepEqual(agentStatusSemantics("cancelled"), { marker: "○", tone: "muted", terminal: true });
  assert.deepEqual(batchStatusSemantics("partial"), { marker: "◐", tone: "warning", terminal: true });
  assert.deepEqual(activitySemantics({ severity: "error", completed: true }), { marker: "✗", tone: "error", terminal: true });
});

test("strict run events have one semantic projection without a compatibility data bag", () => {
  const base = { version: 1, runId: "run-1", sequence: 2, at: "2026-08-15T00:00:00.000Z" };
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "stage", stage: "validate", message: "Validating candidate",
  }), { text: "[validate] Validating candidate", tone: "accent", visible: true });
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "delegate", phase: "updated", batch: 2, completed: 3, total: 4,
    taskId: "review-auth", message: "Reviewing",
  }), { text: "[batch 2 3/4] Reviewing review-auth", tone: "accent", visible: true });
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "telemetry", phase: "observability_health", target: { kind: "lead" },
    status: "degraded", message: "Observer unavailable",
  }), { text: "Observer unavailable", tone: "warning", visible: false });
  assert.deepEqual(projectWikiRunEvent({
    ...base, type: "warning", code: "cleanup_failed", detail: "temp directory remains", message: "Cleanup failed",
  }), { text: "Cleanup failed: temp directory remains", tone: "warning", visible: true });
});

test("run projection contains only stage, health, and liveness consumed by run surfaces", () => {
  const projected = projectWikiRunObservability(run({
    progress: {
      stage: "lead", language: "zh", lead: lead(),
      currentBatch: { batch: 2, status: "running", completed: 1, total: 3, tasks: [
        { id: "a", role: "write", status: "running" },
        { id: "b", role: "review", status: "queued" },
      ] },
    },
  }), now);
  assert.equal(projected.status.label, "运行中");
  assert.deepEqual(projected.stage, { key: "lead", label: "生成" });
  assert.equal(projected.health, "healthy");
  assert.equal(projected.liveness, "quiet");
  assert.equal("context" in projected, false);
  assert.equal("batch" in projected, false);
  assert.equal("activityLabel" in projected, false);
});

test("cluster labels come from assigned paths or a path-like task id", () => {
  assert.equal(wikiTaskClusterLabel({
    id: "write-runtime",
    writePaths: ["wiki/core/runtime/concept.md", "wiki/core/runtime/flows.md"],
  }), "core/runtime");
  assert.equal(wikiTaskClusterLabel({
    id: "review-core",
    reviewPaths: ["wiki/core/domain.md"],
  }), "core");
  assert.equal(wikiTaskClusterLabel({ id: "core/runtime" }), "core/runtime");
  assert.equal(wikiTaskClusterLabel({ id: "wiki/billing/invoice/models/line-item.md" }), "billing/invoice");
  assert.equal(wikiTaskClusterLabel({ id: "write-auth" }), undefined);
  assert.equal(wikiTaskClusterLabel({
    id: "mixed",
    writePaths: ["wiki/core/domain.md", "wiki/core/runtime/concept.md"],
  }), undefined);
  assert.equal(wikiTaskClusterLabel({
    writePaths: ["wiki/overview.md", "wiki/architecture.md"],
  }), "_root");
  assert.equal(wikiTaskClusterLabel({
    reviewPaths: ["overview.md"],
  }), "_root");
});

test("degraded, silent-live, and terminal states are distinct", () => {
  const degraded = projectWikiRunObservability(run({ progress: { stage: "lead", lead: lead({ health: "degraded" }) } }), now);
  assert.equal(degraded.liveness, "degraded");
  const silent = projectWikiRunObservability(run({ progress: { stage: "lead", lead: lead({ lastActivityAt: "2026-08-14T23:58:00.000Z" }) } }), now);
  assert.equal(silent.liveness, "alive_without_activity");
  assert.equal(silent.activityAge, "4m");
  const terminal = projectWikiRunObservability(run({ status: "failed", progress: { stage: "publish", lead: lead({ health: "degraded" }) } }), now);
  assert.equal(terminal.liveness, "terminal");
  assert.equal(terminal.status.tone, "error");
});
