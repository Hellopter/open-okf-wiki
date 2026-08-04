/**
 * Unit tests for durable plan.scout materialization after freeze (U1)
 * and control-plane plan sufficiency re-scout (ADR 0040/0042).
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PlanScoutTask } from "@okf-wiki/contract/wiki-runs";
import { unlockReadyNodes, upstreamsSucceeded } from "./dag.js";
import {
  extractPlanSufficiencyGapUnitIds,
  hasPlanScoutTopology,
  isPlanSufficiencyGapFailure,
  materializePlanScoutsAfterFreeze,
  planScoutDetailFromTask,
  planSufficiencyRoundsUsed,
  schedulePlanSufficiencyRescout,
} from "./plan-scout-materialize.js";
import { migrate } from "./schema.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";
import { openControlFixture } from "./testing/control-fixture.js";

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

test("multi-source: inserts N source scouts + discover.reduce; plan blocked until reduce succeeds", () => {
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
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan.scout.source-api"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.source-web"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.entry"), "ready");

  const edgeSet = new Set(edges(db, "run-1").map((e) => `${e.from}->${e.to}`));
  assert.ok(edgeSet.has("freeze->plan.scout.source-api"));
  assert.ok(edgeSet.has("freeze->plan.scout.source-web"));
  assert.ok(edgeSet.has("freeze->plan.scout.entry"));
  assert.ok(edgeSet.has("plan.scout.source-api->plan.discover.reduce"));
  assert.ok(edgeSet.has("plan.scout.source-web->plan.discover.reduce"));
  assert.ok(edgeSet.has("plan.scout.entry->plan.discover.reduce"));
  assert.ok(edgeSet.has("plan.discover.reduce->plan"));
  assert.ok(!edgeSet.has("freeze->plan"));
  assert.ok(!edgeSet.has("plan.scout.source-api->plan"));

  // Any scout still open → reduce stays blocked → plan stays blocked.
  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), false);
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), false);

  // Succeed critical scouts only; optional thematic still open → reduce NOT ready.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-web");

  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), false);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");

  // All scouts succeeded → reduce ready; plan still blocked until reduce succeeds.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.entry");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), true);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "ready");
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");

  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.discover.reduce");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), true);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan"), "ready");
});

test("thematic scout open → reduce not ready; optional failed + critical succeeded → reduce ready", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  materializePlanScoutsAfterFreeze(host, "run-1", [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
    { kind: "thematic", thematic: "entry", id: "entry", required: false },
  ]);

  // Thematic open (ready) blocks reduce even when critical already succeeded.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");
  assert.equal(nodeState(db, "run-1", "plan.scout.entry"), "ready");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), false);

  // Optional failed is terminal and does not block reduce.
  db.prepare(
    "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.entry");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), true);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "ready");
  // Plan still blocked until reduce succeeds.
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.discover.reduce");
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan"), "ready");
});

test("planScoutDetailFromTask marks source/surface/semantic required as critical", () => {
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
  assert.equal(
    planScoutDetailFromTask({
      kind: "domain",
      id: "domain",
      required: true,
    }).scoutKind,
    "domain",
  );
  assert.equal(
    planScoutDetailFromTask({
      kind: "flow",
      id: "flow",
      required: true,
    }).critical,
    true,
  );
});

test("failed critical scout keeps discover.reduce and plan blocked", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  materializePlanScoutsAfterFreeze(host, "run-1", [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
  ]);
  db.prepare(
    "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");
  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), false);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");
});

test("light path: no plan.discover.reduce node", () => {
  const db = openDb();
  seedRun(db);
  materializePlanScoutsAfterFreeze(dagHost(db), "run-1", []);
  const reduce = asRows(
    db
      .prepare("SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan.discover.reduce'")
      .all("run-1"),
  );
  assert.equal(reduce.length, 0);
});

// ── Plan sufficiency re-scout (control-plane) ─────────────────────────────

test("isPlanSufficiencyGapFailure detects coverage/semantic messages only", () => {
  assert.equal(
    isPlanSufficiencyGapFailure(
      "plan",
      "plan coverage gaps after durable scout synthesis: 1 gap(s): backend",
      "infrastructure",
    ),
    true,
  );
  assert.equal(
    isPlanSufficiencyGapFailure("plan", "coverage gate failed: 2 gap(s): a, b", "schema"),
    true,
  );
  assert.equal(
    isPlanSufficiencyGapFailure(
      "plan",
      "plan semantic sufficiency gaps after durable scout synthesis: api, _cross_source",
      "infrastructure",
    ),
    true,
  );
  assert.equal(
    isPlanSufficiencyGapFailure("plan", "ECONNRESET from provider", "infrastructure"),
    false,
  );
  assert.equal(
    isPlanSufficiencyGapFailure("plan", "coverage gap: backend", "transient"),
    false,
  );
  assert.equal(
    isPlanSufficiencyGapFailure("research.leaf", "coverage gap: backend", "infrastructure"),
    false,
  );
  const covErr = Object.assign(new Error("coverage gate failed: 1 gap(s): x"), {
    name: "CoverageAssertError",
    code: "COVERAGE_GAP",
  });
  assert.equal(isPlanSufficiencyGapFailure("plan", covErr.message, undefined, covErr), true);
});

test("extractPlanSufficiencyGapUnitIds parses message and error.result", () => {
  assert.deepEqual(
    extractPlanSufficiencyGapUnitIds(
      "plan coverage gaps after durable scout synthesis: 2 gap(s): backend, web",
    ),
    ["backend", "web"],
  );
  assert.deepEqual(
    extractPlanSufficiencyGapUnitIds("coverage gate failed: 1 gap(s): mono::packages/api (+2 more)"),
    ["mono::packages/api"],
  );
  assert.deepEqual(
    extractPlanSufficiencyGapUnitIds("semantic sufficiency gap: api, _cross_source"),
    ["api", "_cross_source"],
  );
  assert.deepEqual(
    extractPlanSufficiencyGapUnitIds("x", {
      result: { gaps: ["a", "b"] },
    }),
    ["a", "b"],
  );
});

async function seedScoutPathSucceeded(
  db: DatabaseSync,
  runId = "run-1",
  orch: Record<string, unknown> = {
    planRescoutMaxRounds: 1,
    planScoutCount: 0,
    planScoutMode: "source",
  },
): Promise<void> {
  seedRun(db, runId);
  db.prepare(`UPDATE runs SET freeze_config_json = ? WHERE run_id = ?`).run(
    JSON.stringify({ orchestration: orch }),
    runId,
  );
  const host = dagHost(db);
  materializePlanScoutsAfterFreeze(host, runId, [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
    { kind: "source", sourceId: "web", id: "source:web", required: true },
  ]);
  for (const key of ["plan.scout.source-api", "plan.scout.source-web", "plan.discover.reduce"]) {
    db.prepare(
      "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
    ).run(runId, key);
  }
  unlockReadyNodes(host, runId);
  assert.equal(nodeState(db, runId, "plan"), "ready");
  db.prepare(
    "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = 'plan' AND generation = 0",
  ).run(runId);
}

test("light path: schedulePlanSufficiencyRescout is no-op (no re-arm noise)", async () => {
  const fixture = await openControlFixture();
  try {
    const { db, ctrl } = fixture;
    seedRun(db);
    db.prepare(`UPDATE runs SET freeze_config_json = ? WHERE run_id = ?`).run(
      JSON.stringify({ orchestration: { planRescoutMaxRounds: 1 } }),
      "run-1",
    );
    materializePlanScoutsAfterFreeze(ctrl, "run-1", []);
    db.prepare(
      "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = 'plan'",
    ).run("run-1");
    assert.equal(hasPlanScoutTopology(ctrl, "run-1"), false);
    const ok = schedulePlanSufficiencyRescout(ctrl, {
      runId: "run-1",
      planGeneration: 0,
      message: "plan coverage gaps after durable scout synthesis: 1 gap(s): backend",
      failureClass: "infrastructure",
    });
    assert.equal(ok, false);
    assert.equal(nodeState(db, "run-1", "plan"), "failed");
    assert.equal(planSufficiencyRoundsUsed(ctrl, "run-1"), 0);
  } finally {
    await fixture.close();
  }
});

test("plan coverage gap re-arms scouts + reduce + plan once", async () => {
  const fixture = await openControlFixture();
  try {
    const { db, ctrl } = fixture;
    await seedScoutPathSucceeded(db);

    const ok = schedulePlanSufficiencyRescout(ctrl, {
      runId: "run-1",
      planGeneration: 0,
      message: "plan coverage gaps after durable scout synthesis: 1 gap(s): web",
      failureClass: "infrastructure",
    });
    assert.equal(ok, true);
    assert.equal(planSufficiencyRoundsUsed(ctrl, "run-1"), 1);

    const web = asRow(
      db
        .prepare(
          "SELECT generation, state FROM nodes WHERE run_id = ? AND node_key = ? ORDER BY generation DESC LIMIT 1",
        )
        .get("run-1", "plan.scout.source-web"),
    );
    assert.ok(web);
    assert.equal(requiredNumber(web, "generation"), 1);
    assert.equal(requiredText(web, "state"), "ready");

    const reduce = asRow(
      db
        .prepare(
          "SELECT generation, state FROM nodes WHERE run_id = ? AND node_key = 'plan.discover.reduce' ORDER BY generation DESC LIMIT 1",
        )
        .get("run-1"),
    );
    assert.ok(reduce);
    assert.equal(requiredNumber(reduce, "generation"), 1);
    assert.equal(requiredText(reduce, "state"), "blocked");

    const plan = asRow(
      db
        .prepare(
          "SELECT generation, state, detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan' ORDER BY generation DESC LIMIT 1",
        )
        .get("run-1"),
    );
    assert.ok(plan);
    assert.equal(requiredNumber(plan, "generation"), 1);
    assert.equal(requiredText(plan, "state"), "blocked");
    const detail = JSON.parse(String(plan.detail_json)) as {
      planSufficiencyRound?: number;
      planSufficiencyGaps?: string[];
    };
    assert.equal(detail.planSufficiencyRound, 1);
    assert.deepEqual(detail.planSufficiencyGaps, ["web"]);

    // After gap scout + reduce succeed, plan unlocks.
    db.prepare(
      "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ? AND generation = 1",
    ).run("run-1", "plan.scout.source-web");
    unlockReadyNodes(ctrl, "run-1");
    assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "ready");
    db.prepare(
      "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = 'plan.discover.reduce' AND generation = 1",
    ).run("run-1");
    unlockReadyNodes(ctrl, "run-1");
    assert.equal(nodeState(db, "run-1", "plan"), "ready");
  } finally {
    await fixture.close();
  }
});

test("second coverage gap exhausts planRescoutMaxRounds (fail-closed)", async () => {
  const fixture = await openControlFixture();
  try {
    const { db, ctrl } = fixture;
    await seedScoutPathSucceeded(db);

    assert.equal(
      schedulePlanSufficiencyRescout(ctrl, {
        runId: "run-1",
        planGeneration: 0,
        message: "coverage gate failed: 1 gap(s): api",
        failureClass: "infrastructure",
      }),
      true,
    );

    const planGen = ctrl.currentNodeGeneration("run-1", "plan");
    assert.equal(planGen, 1);
    db.prepare(
      "UPDATE nodes SET state = 'failed' WHERE run_id = ? AND node_key = 'plan' AND generation = ?",
    ).run("run-1", planGen);

    assert.equal(
      schedulePlanSufficiencyRescout(ctrl, {
        runId: "run-1",
        planGeneration: planGen!,
        message: "plan coverage gaps after durable scout synthesis: 1 gap(s): api",
        failureClass: "infrastructure",
      }),
      false,
    );
    assert.equal(ctrl.currentNodeGeneration("run-1", "plan"), 1);
    assert.equal(nodeState(db, "run-1", "plan"), "failed");
    assert.equal(planSufficiencyRoundsUsed(ctrl, "run-1"), 1);
  } finally {
    await fixture.close();
  }
});

test("planRescoutMaxRounds=0 disables re-arm", async () => {
  const fixture = await openControlFixture();
  try {
    const { db, ctrl } = fixture;
    await seedScoutPathSucceeded(db, "run-1", { planRescoutMaxRounds: 0 });
    assert.equal(
      schedulePlanSufficiencyRescout(ctrl, {
        runId: "run-1",
        planGeneration: 0,
        message: "coverage gate failed: 1 gap(s): web",
        failureClass: "infrastructure",
      }),
      false,
    );
  } finally {
    await fixture.close();
  }
});
