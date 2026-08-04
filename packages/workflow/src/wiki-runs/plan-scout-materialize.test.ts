/**
 * Unit tests for durable plan.scout materialization after freeze (U1).
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PlanScoutTask } from "@okf-wiki/contract/wiki-runs";
import {
  materializePlanScoutsAfterFreeze,
  planScoutDetailFromTask,
} from "./plan-scout-materialize.js";
import { unlockReadyNodes, upstreamsSucceeded } from "./dag.js";
import { migrate } from "./schema.js";
import { asRow, asRows, requiredText } from "./sql.js";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

function seedRun(db: DatabaseSync, runId = "run-1"): void {
  const now = "2026-07-30T12:00:00.000Z";
  db.prepare(
    `INSERT INTO runs (
      run_id, workspace_id, definition_version, revision, state, cancel_requested,
      freeze_config_json, freeze_config_digest, intent_json, created_at, updated_at
    ) VALUES (?, 'ws', 5, 1, 'running', 0, '{}', 'deadbeef', '{}', ?, ?)`,
  ).run(runId, now, now);
  db.prepare(
    `INSERT INTO nodes (
      run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
    ) VALUES (?, 'freeze', 'freeze', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(runId);
}

function dagHost(db: DatabaseSync) {
  return {
    db,
    currentNodeGeneration(runId: string, nodeKey: string): number | undefined {
      const row = asRow(
        db
          .prepare(
            `SELECT MAX(generation) AS generation FROM nodes
             WHERE run_id = ? AND node_key = ?`,
          )
          .get(runId, nodeKey),
      );
      if (!row || row.generation == null) return undefined;
      return Number(row.generation);
    },
  };
}

function nodeState(db: DatabaseSync, runId: string, nodeKey: string): string | undefined {
  const row = asRow(
    db
      .prepare(
        "SELECT state FROM nodes WHERE run_id = ? AND node_key = ? ORDER BY generation DESC LIMIT 1",
      )
      .get(runId, nodeKey),
  );
  return row ? requiredText(row, "state") : undefined;
}

function edges(db: DatabaseSync, runId: string): Array<{ from: string; to: string }> {
  return asRows(
    db
      .prepare("SELECT from_key, to_key FROM node_edges WHERE run_id = ? ORDER BY from_key, to_key")
      .all(runId),
  ).map((row) => ({
    from: requiredText(row, "from_key"),
    to: requiredText(row, "to_key"),
  }));
}

test("light path: freeze→plan ready, no plan.scout nodes", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  const tasks = materializePlanScoutsAfterFreeze(host, "run-1", []);
  assert.equal(tasks.length, 0);
  assert.equal(nodeState(db, "run-1", "plan"), "ready");
  assert.deepEqual(edges(db, "run-1"), [{ from: "freeze", to: "plan" }]);
  const scouts = asRows(
    db.prepare("SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan.scout'").all("run-1"),
  );
  assert.equal(scouts.length, 0);
});

test("multi-source: inserts N source scouts, plan blocked until all scouts terminal", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  const tasks: PlanScoutTask[] = [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
    { kind: "source", sourceId: "web", id: "source:web", required: true },
    { kind: "thematic", thematic: "entry", id: "entry", required: false },
  ];
  materializePlanScoutsAfterFreeze(host, "run-1", tasks);

  assert.equal(nodeState(db, "run-1", "plan"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan.scout.source-api"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.source-web"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.entry"), "ready");

  const edgeSet = new Set(edges(db, "run-1").map((e) => `${e.from}->${e.to}`));
  assert.ok(edgeSet.has("freeze->plan.scout.source-api"));
  assert.ok(edgeSet.has("freeze->plan.scout.source-web"));
  assert.ok(edgeSet.has("freeze->plan.scout.entry"));
  assert.ok(edgeSet.has("plan.scout.source-api->plan"));
  assert.ok(edgeSet.has("plan.scout.source-web->plan"));
  assert.ok(edgeSet.has("plan.scout.entry->plan"));
  assert.ok(!edgeSet.has("freeze->plan"));

  // Any scout still open → plan stays blocked.
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), false);

  // Succeed critical scouts only; optional thematic still open → plan NOT ready.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-web");

  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), false);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");

  // All scouts succeeded → plan ready.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.entry");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), true);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan"), "ready");
});

test("thematic scout open → plan not ready; optional failed + critical succeeded → plan ready", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  materializePlanScoutsAfterFreeze(host, "run-1", [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
    { kind: "thematic", thematic: "entry", id: "entry", required: false },
  ]);

  // Thematic open (ready) blocks plan even when critical already succeeded.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");
  assert.equal(nodeState(db, "run-1", "plan.scout.entry"), "ready");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), false);

  // Optional failed is terminal and does not block plan.
  db.prepare(
    "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.entry");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), true);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan"), "ready");
});

test("planScoutDetailFromTask marks source/surface required as critical", () => {
  assert.equal(
    planScoutDetailFromTask({
      kind: "source",
      sourceId: "api",
      id: "source:api",
      required: true,
    }).critical,
    true,
  );
  assert.equal(
    planScoutDetailFromTask({
      kind: "thematic",
      thematic: "entry",
      id: "entry",
      required: false,
    }).critical,
    false,
  );
  assert.equal(
    planScoutDetailFromTask({
      kind: "surface",
      sourceId: "mono",
      path: "packages/core",
      unitId: "mono::packages/core",
      id: "surface:mono::packages/core",
      required: true,
    }).scoutKind,
    "surface",
  );
});

test("failed critical scout keeps plan blocked", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  materializePlanScoutsAfterFreeze(host, "run-1", [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
  ]);
  db.prepare(
    "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), false);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");
});
