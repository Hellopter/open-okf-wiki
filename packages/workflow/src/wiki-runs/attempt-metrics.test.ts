/**
 * Phase 0: attempt metrics columns, snapshot projection, non-terminal helper.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openWikiRuns } from "../wiki-runs.js";
import {
  context,
  freezeAndPlanExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededProbe,
  waitForTerminal,
} from "./__tests__/harness.js";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  projectAttemptMetrics,
  writeAttemptMetrics,
} from "./attempt-metrics.js";
import { configureOwner, migrate } from "./schema.js";
import { buildSnapshot } from "./snapshot.js";
import { asRow, asRows, requiredText } from "./sql.js";

function openMigratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  configureOwner(db);
  migrate(db);
  return db;
}

function attemptColumnNames(db: DatabaseSync): string[] {
  return asRows(db.prepare("PRAGMA table_info(attempts)").all()).map((row) =>
    requiredText(row, "name"),
  );
}

test("migrate adds attempt metric columns on a fresh v5 control store", () => {
  const fresh = openMigratedDb();
  const freshCols = attemptColumnNames(fresh);
  for (const col of [
    "role",
    "model_id",
    "input_tokens",
    "output_tokens",
    "cache_tokens",
    "cost_estimate",
    "tool_calls",
    "wall_time_ms",
    "projection_bytes",
    "stop_reason",
    "metrics_json",
    "failure_class",
  ]) {
    assert.ok(freshCols.includes(col), `missing column ${col}`);
  }
  fresh.close();

  // Older stores are deliberately not migrated by the v5 hard cut.
  const legacy = new DatabaseSync(":memory:");
  configureOwner(legacy);
  legacy.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operator_session_id TEXT,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      cancel_requested INTEGER NOT NULL,
      freeze_config_json TEXT NOT NULL,
      freeze_config_digest TEXT NOT NULL,
      frozen_sources_json TEXT,
      frozen_skill_digest TEXT,
      pinned_sources_json TEXT,
      skill_digest TEXT,
      pinned_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      node_key TEXT NOT NULL,
      node_generation INTEGER NOT NULL,
      run_index INTEGER NOT NULL,
      state TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    ) STRICT;
  `);
  assert.throws(() => migrate(legacy), /unsupported WikiRuns control store/);
  legacy.close();
});

test("migrate rejects persisted runs with no definition version", () => {
  const legacy = new DatabaseSync(":memory:");
  configureOwner(legacy);
  legacy.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY) STRICT");
  legacy.prepare("INSERT INTO runs (run_id) VALUES ('old-run')").run();
  assert.throws(() => migrate(legacy), /unsupported WikiRuns control store/);
  legacy.close();
});

test("writeAttemptMetrics + snapshot project metrics when set", () => {
  const db = openMigratedDb();
  const ts = "2026-07-30T12:00:00.000Z";
  const digest = "a".repeat(64);
  db.prepare(
    `INSERT INTO runs (
      run_id, workspace_id, operator_session_id, definition_version, revision, state, cancel_requested,
      freeze_config_json, freeze_config_digest, intent_json, created_at, updated_at
    ) VALUES (?, ?, NULL, 5, 1, 'running', 0, '{}', ?, '{"mode":"generate"}', ?, ?)`,
  ).run("run-1", "ws-1", digest, ts, ts);
  db.prepare(
    `INSERT INTO nodes (
      run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
    ) VALUES (?, 'plan', 'plan', 'succeeded', 0, NULL, 'attempt-1', NULL)`,
  ).run("run-1");
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest,
      error, started_at, ended_at
    ) VALUES (?, ?, 'plan', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run("attempt-1", "run-1", digest, ts, ts);

  writeAttemptMetrics(
    db,
    "attempt-1",
    mergeAttemptMetrics(
      { inputTokens: 11, outputTokens: 22, modelId: "provider/model" },
      { role: "plan", wallTimeMs: 1500, stopReason: "succeeded" },
    ),
  );

  const row = asRow(db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get("attempt-1"));
  assert.ok(row);
  assert.equal(row.role, "plan");
  assert.equal(row.wall_time_ms, 1500);
  assert.equal(row.input_tokens, 11);
  assert.equal(row.model_id, "provider/model");

  const projected = projectAttemptMetrics(row);
  assert.deepEqual(projected, {
    role: "plan",
    modelId: "provider/model",
    inputTokens: 11,
    outputTokens: 22,
    wallTimeMs: 1500,
    stopReason: "succeeded",
  });

  const snapshot = buildSnapshot(db, "run-1");
  const attempt = snapshot.attempts.find((a) => a.attemptId === "attempt-1");
  assert.ok(attempt?.metrics);
  assert.equal(attempt.metrics.role, "plan");
  assert.equal(attempt.metrics.wallTimeMs, 1500);
  assert.equal(attempt.metrics.inputTokens, 11);
  db.close();
});

test("graphRoleForNodeKind covers definition roles", () => {
  assert.equal(graphRoleForNodeKind("plan"), "plan");
  assert.equal(graphRoleForNodeKind("research.leaf"), "leaf");
  assert.equal(graphRoleForNodeKind("research.domain"), "domain");
  assert.equal(graphRoleForNodeKind("write.root"), "writer");
  assert.equal(graphRoleForNodeKind("review.seat"), "review");
  assert.equal(graphRoleForNodeKind("repair"), "repair");
  assert.equal(graphRoleForNodeKind("freeze"), "mechanical");
  assert.equal(graphRoleForNodeKind("validate.pre"), "mechanical");
});

test("successful freeze attempt path persists wall_time_ms and role", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async ({ workDir }) => succeededProbe(workDir)),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "metrics-start-1", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const freezeAttempt = finished.snapshot.attempts.find((a) => a.nodeKey === "freeze");
  assert.ok(freezeAttempt, "freeze attempt present");
  assert.equal(freezeAttempt.state, "succeeded");
  assert.ok(freezeAttempt.metrics, "metrics projected on snapshot");
  assert.equal(freezeAttempt.metrics.role, "mechanical");
  assert.equal(typeof freezeAttempt.metrics.wallTimeMs, "number");
  assert.ok((freezeAttempt.metrics.wallTimeMs ?? -1) >= 0);
  assert.equal(freezeAttempt.metrics.stopReason, "succeeded");
});
