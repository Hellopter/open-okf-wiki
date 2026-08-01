/**
 * SQLite schema + owner PRAGMAs for WikiRuns.
 */

import type { DatabaseSync } from "node:sqlite";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";

export function configureOwner(db: DatabaseSync): void {
  db.exec("PRAGMA locking_mode=EXCLUSIVE");
  db.exec("PRAGMA journal_mode=WAL");
  // FULL is ideal on local POSIX disks; Windows/cloud FS often reject the
  // underlying fsync with EPERM — NORMAL still flushes at critical moments.
  db.exec(process.platform === "win32" ? "PRAGMA synchronous=NORMAL" : "PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
}

export function migrate(db: DatabaseSync): void {
  const existingRuns = asRow(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get(),
  );
  // This is an intentional hard cut. An old v3 store is not partly migrated,
  // even when it happens to be empty: its table layout cannot attest to v4
  // revision/epoch semantics.
  if (existingRuns?.sql != null && !String(existingRuns.sql).includes("definition_version = 4")) {
    throw new Error(
      "unsupported WikiRuns v3 control store; clear the control store before opening v4",
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      workspace_id TEXT NOT NULL,
      command_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      run_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      accepted INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, command_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operator_session_id TEXT,
      definition_version INTEGER NOT NULL CHECK (definition_version = 4),
      revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      cancel_requested INTEGER NOT NULL,
      freeze_config_json TEXT NOT NULL,
      freeze_config_digest TEXT NOT NULL,
      intent_json TEXT,
      frozen_sources_json TEXT,
      frozen_skill_digest TEXT,
      pinned_sources_json TEXT,
      skill_digest TEXT,
      pinned_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS nodes (
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      node_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      generation INTEGER NOT NULL,
      current_attempt_id TEXT,
      last_attempt_id TEXT,
      detail_json TEXT,
      PRIMARY KEY (run_id, node_key, generation)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      node_key TEXT NOT NULL,
      node_generation INTEGER NOT NULL,
      run_index INTEGER NOT NULL,
      state TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      error TEXT,
      failure_class TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      role TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER,
      cost_estimate REAL,
      tool_calls INTEGER,
      wall_time_ms INTEGER,
      projection_bytes INTEGER,
      stop_reason TEXT,
      metrics_json TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifact_preparations (
      preparation_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      node_key TEXT NOT NULL,
      node_generation INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      kind TEXT NOT NULL,
      digest TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      producer_attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
      sealed_at TEXT NOT NULL,
      UNIQUE (run_id, kind, digest)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS node_outputs (
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      node_key TEXT NOT NULL,
      node_generation INTEGER NOT NULL,
      role TEXT NOT NULL,
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
      PRIMARY KEY (run_id, node_key, node_generation, role)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      event_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (run_id, event_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS gates (
      gate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      node_key TEXT NOT NULL,
      node_generation INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      decision_json TEXT,
      detail_json TEXT,
      opened_at TEXT NOT NULL,
      opened_revision INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS effects (
      effect_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      publication_node_key TEXT NOT NULL,
      publication_node_generation INTEGER NOT NULL,
      gate_id TEXT NOT NULL,
      state TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      expected_live_digest TEXT NOT NULL,
      candidate_artifact_id TEXT NOT NULL,
      candidate_digest TEXT NOT NULL,
      observed_outcome TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS attempt_inputs (
      attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
      role TEXT NOT NULL,
      artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
      PRIMARY KEY (attempt_id, role)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS node_edges (
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      from_key TEXT NOT NULL,
      to_key TEXT NOT NULL,
      PRIMARY KEY (run_id, from_key, to_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_node_edges_to ON node_edges(run_id, to_key);
    CREATE INDEX IF NOT EXISTS idx_gates_run_state ON gates(run_id, state);
    CREATE INDEX IF NOT EXISTS idx_gates_node ON gates(run_id, node_key, node_generation);
    CREATE INDEX IF NOT EXISTS idx_effects_run_state ON effects(run_id, state);
    CREATE INDEX IF NOT EXISTS idx_effects_gate ON effects(run_id, gate_id);
    CREATE INDEX IF NOT EXISTS idx_attempt_inputs_artifact ON attempt_inputs(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_run_node ON attempts(run_id, node_key, node_generation);
    CREATE TABLE IF NOT EXISTS wiki_candidates (
      run_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      parent_candidate_id TEXT,
      produced_by TEXT NOT NULL,
      round INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      producer_node_key TEXT,
      producer_attempt_id TEXT,
      PRIMARY KEY (run_id, candidate_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_wiki_candidates_run ON wiki_candidates(run_id, round);
    CREATE TABLE IF NOT EXISTS evaluation_recoveries (
      recovery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      state TEXT NOT NULL CHECK (state IN ('open', 'continued')),
      source TEXT NOT NULL CHECK (source IN ('mechanical', 'semantic')),
      candidate_id TEXT NOT NULL,
      report_artifact_id TEXT,
      repair_request_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      continued_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_evaluation_recoveries_run_state
      ON evaluation_recoveries(run_id, state);
    CREATE TABLE IF NOT EXISTS run_revisions (
      revision_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      kind TEXT NOT NULL CHECK (kind IN ('guidance', 'scope_change')),
      content TEXT NOT NULL,
      command_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      epoch_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_run_revisions_run ON run_revisions(run_id, created_at);
    CREATE TABLE IF NOT EXISTS execution_epochs (
      epoch_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      ordinal INTEGER NOT NULL,
      scope_revision_id TEXT REFERENCES run_revisions(revision_id),
      state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'completed')),
      created_at TEXT NOT NULL,
      UNIQUE(run_id, ordinal)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS review_threads (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      candidate_digest TEXT NOT NULL,
      page_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      selected_text_digest TEXT NOT NULL,
      body TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'superseded')),
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_review_threads_run ON review_threads(run_id, state, created_at);
    CREATE TABLE IF NOT EXISTS candidate_review_artifacts (
      run_id TEXT NOT NULL REFERENCES runs(run_id),
      candidate_digest TEXT NOT NULL,
      baseline_digest TEXT NOT NULL,
      baseline_artifact_id TEXT,
      evidence_digest TEXT,
      evidence_artifact_id TEXT,
      PRIMARY KEY(run_id, candidate_digest)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_index_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_run_index_events_workspace
      ON run_index_events(workspace_id, event_id);
  `);
  const runColumns = asRows(db.prepare("PRAGMA table_info(runs)").all()).map((row) =>
    requiredText(row, "name"),
  );
  if (!runColumns.includes("definition_version")) {
    throw new Error(
      "unsupported WikiRuns v3 control store; clear the control store before opening v4",
    );
  }
  const unsupportedRun = asRow(
    db
      .prepare(
        "SELECT run_id FROM runs WHERE definition_version IS NULL OR definition_version <> 4 LIMIT 1",
      )
      .get(),
  );
  if (unsupportedRun) {
    throw new Error(
      `unsupported WikiRuns definition version for run ${requiredText(unsupportedRun, "run_id")}; clear the control store before opening v4`,
    );
  }
  if (!runColumns.includes("frozen_sources_json")) {
    db.exec("ALTER TABLE runs ADD COLUMN frozen_sources_json TEXT");
  }
  if (!runColumns.includes("frozen_skill_digest")) {
    db.exec("ALTER TABLE runs ADD COLUMN frozen_skill_digest TEXT");
  }
  const candidateReviewColumns = asRows(
    db.prepare("PRAGMA table_info(candidate_review_artifacts)").all(),
  ).map((row) => requiredText(row, "name"));
  if (!candidateReviewColumns.includes("baseline_artifact_id")) {
    db.exec("ALTER TABLE candidate_review_artifacts ADD COLUMN baseline_artifact_id TEXT");
  }
  if (!candidateReviewColumns.includes("evidence_artifact_id")) {
    db.exec("ALTER TABLE candidate_review_artifacts ADD COLUMN evidence_artifact_id TEXT");
  }
  // A v2 Run always carries its StartRun intent; no recovery default exists.
  if (!runColumns.includes("intent_json")) {
    const count = asRow(db.prepare("SELECT COUNT(*) AS count FROM runs").get());
    if (requiredNumber(count ?? {}, "count") > 0) {
      throw new Error(
        "unsupported WikiRuns database: existing runs have no sealed intent; clear the control store before upgrading",
      );
    }
    db.exec("ALTER TABLE runs ADD COLUMN intent_json TEXT");
  }
  const missingIntent = asRow(
    db
      .prepare("SELECT run_id FROM runs WHERE intent_json IS NULL OR intent_json = '' LIMIT 1")
      .get(),
  );
  if (missingIntent) {
    throw new Error(
      `unsupported WikiRuns run ${requiredText(missingIntent, "run_id")}: sealed intent is missing`,
    );
  }
  const nodeColumns = asRows(db.prepare("PRAGMA table_info(nodes)").all()).map((row) =>
    requiredText(row, "name"),
  );
  if (!nodeColumns.includes("detail_json")) {
    db.exec("ALTER TABLE nodes ADD COLUMN detail_json TEXT");
  }
  const attemptColumns = asRows(db.prepare("PRAGMA table_info(attempts)").all()).map((row) =>
    requiredText(row, "name"),
  );
  if (!attemptColumns.includes("failure_class")) {
    db.exec("ALTER TABLE attempts ADD COLUMN failure_class TEXT");
  }
  // Phase 0 attempt observation metrics (hard-cut: additive columns only; no dual reader).
  const attemptMetricColumns: Array<{ name: string; sqlType: string }> = [
    { name: "role", sqlType: "TEXT" },
    { name: "model_id", sqlType: "TEXT" },
    { name: "input_tokens", sqlType: "INTEGER" },
    { name: "output_tokens", sqlType: "INTEGER" },
    { name: "cache_tokens", sqlType: "INTEGER" },
    { name: "cost_estimate", sqlType: "REAL" },
    { name: "tool_calls", sqlType: "INTEGER" },
    { name: "wall_time_ms", sqlType: "INTEGER" },
    { name: "projection_bytes", sqlType: "INTEGER" },
    { name: "stop_reason", sqlType: "TEXT" },
    { name: "metrics_json", sqlType: "TEXT" },
  ];
  for (const column of attemptMetricColumns) {
    if (!attemptColumns.includes(column.name)) {
      db.exec(`ALTER TABLE attempts ADD COLUMN ${column.name} ${column.sqlType}`);
    }
  }
}
