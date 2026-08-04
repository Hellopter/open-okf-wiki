/**
 * Unit tests for durable plan.scout materialization after freeze (U1),
 * L3 two-wave discover (WP3), and control-plane plan sufficiency re-scout
 * (ADR 0040/0042).
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PlanScoutTask } from "@okf-wiki/contract/wiki-runs";
import { unlockReadyNodes, upstreamsSucceeded } from "./dag.js";
import {
  extractPlanSufficiencyGapUnitIds,
  hasPlanScoutTopology,
  isDiscoverWaveATask,
  isDiscoverWaveBTask,
  isPlanSufficiencyGapFailure,
  materializePlanScoutsAfterFreeze,
  maybeMaterializeDiscoverWaveB,
  needsTwoWaveDiscover,
  partitionPlanScoutTasksByDiscoverWave,
  planScoutDetailFromTask,
  planSufficiencyRoundsUsed,
  readDiscoverWaveFromDetail,
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
  // One-wave path: only unit scouts (no Wave B kinds) — all materialize at freeze.
  const tasks: PlanScoutTask[] = [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
    { kind: "source", sourceId: "web", id: "source:web", required: true },
  ];
  materializePlanScoutsAfterFreeze(host, "run-1", tasks, { sourceCount: 2 });

  assert.equal(nodeState(db, "run-1", "plan"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan.scout.source-api"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.source-web"), "ready");
  // discoverWave:2 (final) when no Wave B tasks
  const reduceDetail = asRow(
    db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan.discover.reduce'",
      )
      .get("run-1"),
  );
  assert.equal(readDiscoverWaveFromDetail(reduceDetail?.detail_json), 2);

  const edgeSet = new Set(edges(db, "run-1").map((e) => `${e.from}->${e.to}`));
  assert.ok(edgeSet.has("freeze->plan.scout.source-api"));
  assert.ok(edgeSet.has("freeze->plan.scout.source-web"));
  assert.ok(edgeSet.has("plan.scout.source-api->plan.discover.reduce"));
  assert.ok(edgeSet.has("plan.scout.source-web->plan.discover.reduce"));
  assert.ok(edgeSet.has("plan.discover.reduce->plan"));
  assert.ok(!edgeSet.has("freeze->plan"));
  assert.ok(!edgeSet.has("plan.scout.source-api->plan"));

  // Any scout still open → reduce stays blocked → plan stays blocked.
  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), false);
  assert.equal(upstreamsSucceeded(host, "run-1", "plan"), false);

  // Succeed one critical scout only → reduce NOT ready.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-api");

  assert.equal(upstreamsSucceeded(host, "run-1", "plan.discover.reduce"), false);
  unlockReadyNodes(host, "run-1");
  assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "blocked");
  assert.equal(nodeState(db, "run-1", "plan"), "blocked");

  // All scouts succeeded → reduce ready; plan still blocked until reduce succeeds.
  db.prepare(
    "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
  ).run("run-1", "plan.scout.source-web");
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

test("partition / needsTwoWaveDiscover: unit vs semantic by kind", () => {
  const tasks: PlanScoutTask[] = [
    { kind: "source", sourceId: "api", id: "source:api", required: true },
    { kind: "source", sourceId: "web", id: "source:web", required: true },
    { kind: "domain", id: "domain:api", sourceId: "api", required: true },
    { kind: "flow", id: "flow:cross", sourceId: "cross", cross: true, required: true },
    { kind: "thematic", thematic: "entry", id: "entry", required: false },
  ];
  assert.ok(tasks.filter(isDiscoverWaveATask).every((t) => t.kind === "source"));
  assert.ok(tasks.filter(isDiscoverWaveBTask).every((t) => t.kind !== "source"));
  const { waveA, waveB } = partitionPlanScoutTasksByDiscoverWave(tasks);
  assert.equal(waveA.length, 2);
  assert.equal(waveB.length, 3);
  assert.equal(needsTwoWaveDiscover(2, tasks), true);
  assert.equal(needsTwoWaveDiscover(1, tasks), false, "single-source never forced two-wave");
  assert.equal(
    needsTwoWaveDiscover(2, tasks.filter(isDiscoverWaveATask)),
    false,
    "unit-only has no Wave B",
  );
});

test("multi-source L3: after freeze only unit scouts; after reduce success Wave B appears", async () => {
  const fixture = await openControlFixture();
  try {
    const { db, ctrl } = fixture;
    const { mkdir, writeFile } = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const { runWorkDir } = await import("@okf-wiki/core");

    seedRun(db);
    db.prepare(
      `UPDATE runs SET freeze_config_json = ?, pinned_sources_json = ? WHERE run_id = ?`,
    ).run(
      JSON.stringify({
        orchestration: {
          planScoutMode: "hybrid",
          planScoutCount: 0,
          planSurveyTaskBudget: 2,
          planRescoutMaxRounds: 1,
        },
      }),
      JSON.stringify([{ id: "api" }, { id: "web" }]),
      "run-1",
    );

    // Sealed coverage under run work dir so Wave B re-selection works.
    const analysisDir = pathMod.join(runWorkDir(ctrl.workspace.rootPath, "run-1"), "analysis");
    await mkdir(analysisDir, { recursive: true });
    await writeFile(
      pathMod.join(analysisDir, "coverage-inventory.json"),
      JSON.stringify({
        version: 1,
        sources: [
          { sourceId: "api", surfaces: [] },
          { sourceId: "web", surfaces: [] },
        ],
      }),
      "utf8",
    );
    await writeFile(
      pathMod.join(analysisDir, "coverage-plan.json"),
      JSON.stringify({
        version: 1,
        requiredUnits: [
          { kind: "source", id: "api", sourceId: "api" },
          { kind: "source", id: "web", sourceId: "web" },
        ],
      }),
      "utf8",
    );

    const tasks: PlanScoutTask[] = [
      { kind: "source", sourceId: "api", id: "source:api", required: true },
      { kind: "source", sourceId: "web", id: "source:web", required: true },
      { kind: "domain", id: "domain:api", sourceId: "api", required: true },
      { kind: "domain", id: "domain:web", sourceId: "web", required: true },
      { kind: "flow", id: "flow:api", sourceId: "api", required: true },
      { kind: "flow", id: "flow:web", sourceId: "web", required: true },
      { kind: "flow", id: "flow:cross", sourceId: "cross", cross: true, required: true },
    ];
    const materialized = materializePlanScoutsAfterFreeze(ctrl, "run-1", tasks, {
      sourceCount: 2,
    });
    assert.equal(materialized.length, 2, "freeze materializes Wave A unit scouts only");
    assert.ok(materialized.every((t) => t.kind === "source"));

    assert.equal(nodeState(db, "run-1", "plan.scout.source-api"), "ready");
    assert.equal(nodeState(db, "run-1", "plan.scout.source-web"), "ready");
    assert.equal(nodeState(db, "run-1", "plan.scout.domain-api"), undefined);
    assert.equal(nodeState(db, "run-1", "plan.scout.flow-cross"), undefined);
    assert.equal(nodeState(db, "run-1", "plan"), "blocked");

    const reduce0 = asRow(
      db
        .prepare(
          "SELECT detail_json, generation FROM nodes WHERE run_id = ? AND node_key = 'plan.discover.reduce' ORDER BY generation DESC LIMIT 1",
        )
        .get("run-1"),
    );
    assert.equal(readDiscoverWaveFromDetail(reduce0?.detail_json), 1);

    // Complete Wave A scouts → intermediate reduce ready.
    for (const key of ["plan.scout.source-api", "plan.scout.source-web"]) {
      db.prepare(
        "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
      ).run("run-1", key);
    }
    unlockReadyNodes(ctrl, "run-1");
    assert.equal(nodeState(db, "run-1", "plan.discover.reduce"), "ready");

    // Intermediate reduce success → Wave B materialize.
    db.prepare(
      "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = 'plan.discover.reduce' AND generation = 0",
    ).run("run-1");
    const opened = maybeMaterializeDiscoverWaveB(ctrl, {
      attemptId: "a1",
      nodeGeneration: 0,
      nodeKey: "plan.discover.reduce",
      kind: "plan.discover.reduce",
      runId: "run-1",
    });
    assert.equal(opened, true, "Wave B opens after intermediate reduce");

    assert.equal(nodeState(db, "run-1", "plan.scout.domain-api"), "ready");
    assert.equal(nodeState(db, "run-1", "plan.scout.domain-web"), "ready");
    assert.equal(nodeState(db, "run-1", "plan.scout.flow-api"), "ready");
    assert.equal(nodeState(db, "run-1", "plan.scout.flow-web"), "ready");
    assert.equal(nodeState(db, "run-1", "plan.scout.flow-cross"), "ready");
    assert.equal(nodeState(db, "run-1", "plan"), "blocked");

    const reduce1 = asRow(
      db
        .prepare(
          "SELECT generation, state, detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan.discover.reduce' ORDER BY generation DESC LIMIT 1",
        )
        .get("run-1"),
    );
    assert.equal(requiredNumber(reduce1!, "generation"), 1);
    assert.equal(requiredText(reduce1!, "state"), "blocked");
    assert.equal(readDiscoverWaveFromDetail(reduce1?.detail_json), 2);

    // Second maybeMaterialize on wave-2 must not loop.
    const again = maybeMaterializeDiscoverWaveB(ctrl, {
      attemptId: "a2",
      nodeGeneration: 1,
      nodeKey: "plan.discover.reduce",
      kind: "plan.discover.reduce",
      runId: "run-1",
    });
    assert.equal(again, false, "no infinite Wave B loop");
    assert.equal(ctrl.currentNodeGeneration("run-1", "plan.discover.reduce"), 1);

    // Also reject re-call on already-succeeded wave-1 gen after bump (stale).
    const stale = maybeMaterializeDiscoverWaveB(ctrl, {
      attemptId: "a3",
      nodeGeneration: 0,
      nodeKey: "plan.discover.reduce",
      kind: "plan.discover.reduce",
      runId: "run-1",
    });
    assert.equal(stale, false);

    // Wave B scouts + final reduce → plan unlocks.
    for (const key of [
      "plan.scout.domain-api",
      "plan.scout.domain-web",
      "plan.scout.flow-api",
      "plan.scout.flow-web",
      "plan.scout.flow-cross",
    ]) {
      db.prepare(
        "UPDATE nodes SET state = 'succeeded' WHERE run_id = ? AND node_key = ?",
      ).run("run-1", key);
    }
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

test("single-source L1/L2: all narrow tasks in one wave (no forced double reduce)", () => {
  const db = openDb();
  seedRun(db);
  const host = dagHost(db);
  const tasks: PlanScoutTask[] = [
    { kind: "source", sourceId: "mono", id: "source:mono", required: true },
    { kind: "domain", id: "domain:mono", sourceId: "mono", required: true },
    { kind: "flow", id: "flow:mono", sourceId: "mono", required: true },
    { kind: "thematic", thematic: "entry", id: "entry", required: false },
  ];
  const materialized = materializePlanScoutsAfterFreeze(host, "run-1", tasks, {
    sourceCount: 1,
  });
  assert.equal(materialized.length, 4);
  assert.equal(nodeState(db, "run-1", "plan.scout.source-mono"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.domain-mono"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.flow-mono"), "ready");
  assert.equal(nodeState(db, "run-1", "plan.scout.entry"), "ready");
  const reduceDetail = asRow(
    db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan.discover.reduce'",
      )
      .get("run-1"),
  );
  assert.equal(readDiscoverWaveFromDetail(reduceDetail?.detail_json), 2);
});

test("light path freeze→plan unchanged (0 scouts)", () => {
  const db = openDb();
  seedRun(db);
  const tasks = materializePlanScoutsAfterFreeze(dagHost(db), "run-1", [], { sourceCount: 1 });
  assert.equal(tasks.length, 0);
  assert.equal(nodeState(db, "run-1", "plan"), "ready");
  assert.deepEqual(edges(db, "run-1"), [{ from: "freeze", to: "plan" }]);
  assert.equal(
    asRows(
      db
        .prepare("SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan.discover.reduce'")
        .all("run-1"),
    ).length,
    0,
  );
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
  // Source-qualified semantic + flow:cross round-trip via detail.sourceId
  assert.deepEqual(
    planScoutDetailFromTask({
      kind: "domain",
      id: "domain:api",
      sourceId: "api",
      required: true,
    }),
    {
      scoutKind: "domain",
      sourceId: "api",
      critical: true,
      taskLabel: "domain:api",
    },
  );
  assert.deepEqual(
    planScoutDetailFromTask({
      kind: "flow",
      id: "flow:cross",
      sourceId: "cross",
      cross: true,
      required: true,
    }),
    {
      scoutKind: "flow",
      sourceId: "cross",
      critical: true,
      taskLabel: "flow:cross",
    },
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
