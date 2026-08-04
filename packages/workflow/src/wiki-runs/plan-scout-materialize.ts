/**
 * Host-owned durable plan.scout materialization after freeze, plus control-plane
 * plan sufficiency re-scout (ADR 0040/0042) and L3 two-wave discover (WP3).
 *
 * Topology (semantic discovery):
 *   light: freeze → plan (ready) — no scouts, no reduce
 *   single-source / one-wave: freeze → plan.scout.* → plan.discover.reduce → plan
 *   multi-source L3 two-wave:
 *     freeze → Wave A plan.scout.* (unit source/surface only)
 *           → plan.discover.reduce (discoverWave:1 intermediate)
 *           → Wave B plan.scout.* (source-qualified domain/flow + flow:cross)
 *           → plan.discover.reduce (discoverWave:2 final)
 *           → plan
 *   (plan blocked until final mechanical reduce succeeds;
 *    reduce waits until all scouts terminal — critical must succeed;
 *    optional may fail/cancel)
 *
 * Coverage / semantic gap on plan → schedulePlanSufficiencyRescout re-arms gap
 * scouts + reduce + plan (gen+1) while planRescoutMaxRounds remains; fail-closed
 * when exhausted. Nested agent re-scout is not used.
 *
 * Task selection is pure contract code; this module only inserts/re-arms nodes.
 * plan.discover.reduce is pre-plan only — never part of post-plan execution graph.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type CoverageInventory,
  type CoveragePlan,
  parseSealedCoverageInventory,
  parseSealedCoveragePlan,
} from "@okf-wiki/contract/coverage";
import {
  contractForNode,
  type PlanScoutTask,
  planScoutNodeKey,
  planScoutTaskFromDetail,
  scoutTaskLabel,
  selectPlanScoutTasks,
} from "@okf-wiki/contract/wiki-runs";
import {
  resolveOrchestration,
  type WorkspaceOrchestration,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract/workspace";
import { runWorkDir } from "@okf-wiki/core";
import {
  COVERAGE_INVENTORY_FILE,
  COVERAGE_PLAN_FILE,
  sealedCoverageInventoryRelativePath,
  sealedCoveragePlanRelativePath,
} from "./coverage-bridge.js";
import { now } from "./crypto-util.js";
import { unlockReadyNodes, type DagControl } from "./dag.js";
import { asRow, asRows, parseJson } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

/** detail_json shape sealed on each durable plan.scout node. */
export type PlanScoutNodeDetail = {
  scoutKind: string;
  unitId?: string;
  sourceId?: string;
  surfacePath?: string;
  critical: boolean;
  taskLabel: string;
};

/** Discover reduce wave marker (detail_json.discoverWave). 1 = intermediate, 2 = final. */
export type DiscoverWave = 1 | 2;

export function planScoutDetailFromTask(task: PlanScoutTask): PlanScoutNodeDetail {
  const taskLabel = scoutTaskLabel(task);
  if (task.kind === "thematic") {
    return {
      scoutKind: task.thematic,
      critical: false,
      taskLabel,
    };
  }
  if (task.kind === "source") {
    return {
      scoutKind: "source",
      sourceId: task.sourceId,
      unitId: task.sourceId,
      critical: task.required,
      taskLabel,
    };
  }
  if (task.kind === "surface") {
    return {
      scoutKind: "surface",
      sourceId: task.sourceId,
      surfacePath: task.path,
      unitId: task.unitId,
      critical: task.required,
      taskLabel,
    };
  }
  // Semantic: domain | flow | concept (source-qualified or flow:cross)
  return {
    scoutKind: task.kind,
    ...(task.sourceId ? { sourceId: task.sourceId } : {}),
    critical: task.required,
    taskLabel,
  };
}

const DISCOVER_REDUCE_KEY = "plan.discover.reduce" as const;

// ---------------------------------------------------------------------------
// L3 two-wave discover: Wave A = unit surveys; Wave B = semantic (+ thematic)
// ---------------------------------------------------------------------------

/**
 * Wave A (unit): source / surface surveys only.
 * Works with both global and source-qualified semantic kinds (WP2).
 */
export function isDiscoverWaveATask(task: PlanScoutTask): boolean {
  return task.kind === "source" || task.kind === "surface";
}

/**
 * Wave B (semantic + soft spine): domain / flow / concept / thematic.
 * Includes source-qualified domain/flow and flow:cross.
 */
export function isDiscoverWaveBTask(task: PlanScoutTask): boolean {
  return !isDiscoverWaveATask(task);
}

/** Partition selected tasks into discover waves (by kind). */
export function partitionPlanScoutTasksByDiscoverWave(
  tasks: readonly PlanScoutTask[],
): { waveA: PlanScoutTask[]; waveB: PlanScoutTask[] } {
  const waveA: PlanScoutTask[] = [];
  const waveB: PlanScoutTask[] = [];
  for (const task of tasks) {
    if (isDiscoverWaveATask(task)) waveA.push(task);
    else waveB.push(task);
  }
  return { waveA, waveB };
}

/**
 * Multi-source L3 two-wave when sourceCount ≥ 2 and both unit + semantic waves
 * have tasks. Single-source L1/L2 keeps one wave (no forced double reduce).
 */
export function needsTwoWaveDiscover(
  sourceCount: number,
  tasks: readonly PlanScoutTask[],
): boolean {
  if (sourceCount < 2) return false;
  const { waveA, waveB } = partitionPlanScoutTasksByDiscoverWave(tasks);
  return waveA.length > 0 && waveB.length > 0;
}

/** Read discoverWave from a reduce (or any) node detail_json; default 2 (final). */
export function readDiscoverWaveFromDetail(detailJson: unknown): DiscoverWave {
  if (detailJson == null || detailJson === "") return 2;
  try {
    const raw =
      typeof detailJson === "string"
        ? (JSON.parse(detailJson) as unknown)
        : detailJson;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const w = (raw as { discoverWave?: unknown }).discoverWave;
      if (w === 1 || w === 1.0) return 1;
      if (w === 2 || w === 2.0) return 2;
    }
  } catch {
    // corrupt → treat as final (fail-closed: no extra wave)
  }
  return 2;
}

function discoverReduceDetailJson(wave: DiscoverWave): string {
  return JSON.stringify({ discoverWave: wave });
}

function mergeDiscoverWaveDetail(
  host: Pick<DagControl, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
  wave: DiscoverWave,
): void {
  const row = asRow(
    host.db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(runId, nodeKey, generation),
  );
  let base: Record<string, unknown> = {};
  if (row?.detail_json != null && row.detail_json !== "") {
    try {
      const parsed = JSON.parse(String(row.detail_json)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      base = {};
    }
  }
  base.discoverWave = wave;
  host.db
    .prepare(
      `UPDATE nodes SET detail_json = ?
       WHERE run_id = ? AND node_key = ? AND generation = ?`,
    )
    .run(JSON.stringify(base), runId, nodeKey, generation);
}

/** Insert plan.scout nodes + freeze→scout→reduce edges (idempotent by key). */
function insertPlanScoutNodes(
  host: Pick<DagControl, "db">,
  runId: string,
  tasks: readonly PlanScoutTask[],
  opts?: { initialState?: "blocked" | "ready" },
): void {
  const initialState = opts?.initialState ?? "blocked";
  for (const task of tasks) {
    const nodeKey = planScoutNodeKey(task);
    const existing = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = 0",
        )
        .get(runId, nodeKey),
    );
    if (!existing) {
      contractForNode("plan.scout", nodeKey);
      const detail = planScoutDetailFromTask(task);
      host.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, 'plan.scout', ?, 0, NULL, NULL, ?)`,
        )
        .run(runId, nodeKey, initialState, JSON.stringify(detail));
    }
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'freeze', ?)
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId, nodeKey);
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId, nodeKey, DISCOVER_REDUCE_KEY);
  }
}

function ensureDiscoverReduceAndBlockedPlan(
  host: Pick<DagControl, "db">,
  runId: string,
  discoverWave: DiscoverWave,
): void {
  const existingReduce = asRow(
    host.db
      .prepare(
        "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = 0",
      )
      .get(runId, DISCOVER_REDUCE_KEY),
  );
  const reduceDetail = discoverReduceDetailJson(discoverWave);
  if (!existingReduce) {
    contractForNode("plan.discover.reduce", DISCOVER_REDUCE_KEY);
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, 'plan.discover.reduce', 'blocked', 0, NULL, NULL, ?)`,
      )
      .run(runId, DISCOVER_REDUCE_KEY, reduceDetail);
  } else {
    // Pin retry: keep reduce blocked until scouts finish (do not force ready).
    host.db
      .prepare(
        `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL, detail_json = ?
         WHERE run_id = ? AND node_key = ? AND generation = 0
           AND state IN ('ready', 'blocked', 'invalidated', 'failed')`,
      )
      .run(reduceDetail, runId, DISCOVER_REDUCE_KEY);
  }

  host.db
    .prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, 'plan')
       ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
    )
    .run(runId, DISCOVER_REDUCE_KEY);

  const existingPlan = asRow(
    host.db
      .prepare(
        "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = 0",
      )
      .get(runId),
  );
  if (!existingPlan) {
    contractForNode("plan", "plan");
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, 'plan', 'plan', 'blocked', 0, NULL, NULL, NULL)`,
      )
      .run(runId);
  } else {
    // Pin retry: keep plan blocked until final reduce succeeds (do not force ready).
    host.db
      .prepare(
        `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = 'plan' AND generation = 0
           AND state IN ('ready', 'invalidated', 'failed')`,
      )
      .run(runId);
  }
}

export type MaterializePlanScoutsOptions = {
  /**
   * Inventoried / pinned source count. ≥2 enables L3 two-wave when both unit
   * and semantic waves are present. Omit to infer from source/surface tasks.
   */
  sourceCount?: number;
};

/**
 * Insert durable plan.scout.* + plan.discover.reduce, or light-path freeze→plan.
 * Idempotent for node keys already present (pin retry / recovery).
 *
 * Multi-source L3: only Wave A unit scouts at freeze (discoverWave:1).
 * Wave B materializes on intermediate reduce success via
 * {@link maybeMaterializeDiscoverWaveB}.
 *
 * @returns tasks materialized at freeze (Wave A only when two-wave; empty on light)
 */
export function materializePlanScoutsAfterFreeze(
  host: DagControl & { db: DatabaseSync },
  runId: string,
  tasks: readonly PlanScoutTask[],
  options?: MaterializePlanScoutsOptions,
): PlanScoutTask[] {
  const existingPlan = asRow(
    host.db
      .prepare(
        "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = 0",
      )
      .get(runId),
  );

  if (tasks.length === 0) {
    // Light path: freeze → plan ready (no reduce).
    if (!existingPlan) {
      contractForNode("plan", "plan");
      host.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, 'plan', 'plan', 'ready', 0, NULL, NULL, NULL)`,
        )
        .run(runId);
    } else {
      host.db
        .prepare(
          `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
           WHERE run_id = ? AND node_key = 'plan' AND generation = 0
             AND state IN ('blocked', 'invalidated', 'failed')`,
        )
        .run(runId);
    }
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'freeze', 'plan')
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId);
    return [];
  }

  const inferredSourceCount = tasks.filter((t) => t.kind === "source").length;
  const sourceCount = options?.sourceCount ?? inferredSourceCount;
  const twoWave = needsTwoWaveDiscover(sourceCount, tasks);
  const { waveA } = partitionPlanScoutTasksByDiscoverWave(tasks);
  // Two-wave: freeze materializes unit surveys only; one-wave: all tasks.
  const freezeTasks = twoWave ? waveA : [...tasks];
  const discoverWave: DiscoverWave = twoWave ? 1 : 2;

  // Scout path: freeze → each scout → plan.discover.reduce → plan (blocked).
  insertPlanScoutNodes(host, runId, freezeTasks, { initialState: "blocked" });
  ensureDiscoverReduceAndBlockedPlan(host, runId, discoverWave);

  unlockReadyNodes(host, runId);
  // Return freeze-materialized tasks (Wave B deferred when twoWave).
  return [...freezeTasks];
}

/**
 * After intermediate plan.discover.reduce success (discoverWave:1): materialize
 * Wave B semantic scouts, re-arm reduce at gen+1 with discoverWave:2, re-block plan.
 *
 * Fail-closed loop guard: only runs when detail.discoverWave === 1. Final wave (2)
 * never re-arms. Host-owned only — no Pi orchestrator node.
 *
 * @returns true when Wave B was materialized (caller still runs recomputeRunState).
 */
export function maybeMaterializeDiscoverWaveB(
  host: PlanRescoutControl & {
    workspace: { rootPath: string };
    workspaceForRun?: (runId: string) => { rootPath: string };
  },
  claim: ClaimedNode,
): boolean {
  if (claim.kind !== "plan.discover.reduce" && claim.nodeKey !== DISCOVER_REDUCE_KEY) {
    return false;
  }

  const reduceRow = asRow(
    host.db
      .prepare(
        "SELECT detail_json, state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(claim.runId, DISCOVER_REDUCE_KEY, claim.nodeGeneration),
  );
  if (!reduceRow) return false;

  const wave = readDiscoverWaveFromDetail(reduceRow.detail_json);
  // Only intermediate wave-1 reduce may open Wave B (prevents infinite re-arm).
  if (wave !== 1) return false;

  const rootPath =
    host.workspaceForRun?.(claim.runId)?.rootPath ?? host.workspace.rootPath;
  const { inventory, coveragePlan } = loadCoverageFromSealedFreeze(host, {
    rootPath,
    runId: claim.runId,
  });
  const sourceCount = resolveDiscoverSourceCount(host, claim.runId, inventory);
  // Single-source never forced into a second wave even if detail says 1.
  if (sourceCount < 2) return false;

  const orch = loadRunOrchestration(host, claim.runId);
  let allTasks: PlanScoutTask[] = [];
  try {
    allTasks = selectPlanScoutTasks({
      orch,
      coverageInventory: inventory,
      coveragePlan,
    });
  } catch {
    // Fail-closed: over-budget / selection error — do not open Wave B; leave plan blocked.
    return false;
  }

  const { waveB } = partitionPlanScoutTasksByDiscoverWave(allTasks);
  if (waveB.length === 0) return false;

  // Skip tasks already present (idempotent recovery).
  const toInsert = waveB.filter((task) => {
    const nodeKey = planScoutNodeKey(task);
    return !asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? LIMIT 1",
        )
        .get(claim.runId, nodeKey),
    );
  });

  // If every Wave B key already exists and reduce was not yet bumped, still re-arm
  // only when current generation is the claim (crash mid-materialize recovery).
  if (toInsert.length === 0) {
    // Wave B already fully present — still re-arm reduce if still at wave-1 gen.
    // (Otherwise a second reduce success would unlock plan without semantic merge.)
  } else {
    insertPlanScoutNodes(host, claim.runId, toInsert, { initialState: "ready" });
  }

  // Re-arm reduce at gen+1 blocked with discoverWave:2 (final).
  try {
    host.applyRerunAt(claim.runId, DISCOVER_REDUCE_KEY, claim.nodeGeneration, undefined, {
      selfOnly: true,
    });
  } catch {
    // already bumped / stale — do not loop
    return false;
  }
  const nextReduceGen = host.currentNodeGeneration(claim.runId, DISCOVER_REDUCE_KEY);
  if (nextReduceGen === undefined) return false;
  demoteNodeState(host, claim.runId, DISCOVER_REDUCE_KEY, nextReduceGen, "blocked");
  mergeDiscoverWaveDetail(host, claim.runId, DISCOVER_REDUCE_KEY, nextReduceGen, 2);

  // Keep plan blocked until final reduce succeeds.
  const planGen = host.currentNodeGeneration(claim.runId, "plan");
  if (planGen !== undefined) {
    demoteNodeState(host, claim.runId, "plan", planGen, "blocked");
  }

  unlockReadyNodes(host, claim.runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(now(), claim.runId);

  return true;
}

/** Load sealed freeze coverage inventory/plan for wave-B re-selection. */
function loadCoverageFromSealedFreeze(
  host: { db: DatabaseSync },
  input: { rootPath: string; runId: string },
): { inventory?: CoverageInventory; coveragePlan?: CoveragePlan } {
  const runDir = runWorkDir(input.rootPath, input.runId);
  const preparations: ArtifactPreparation[] = [];
  const invRel = sealedCoverageInventoryRelativePath(host.db, input.runId);
  if (invRel) {
    preparations.push({
      artifactId: "sealed-coverage-inventory",
      digest: "",
      kind: "receipt",
      preparationId: "sealed-inv",
      relativePath: invRel,
      role: "coverage_inventory",
      sourceDirectory: path.join(runDir, invRel),
    });
  }
  const planRel = sealedCoveragePlanRelativePath(host.db, input.runId);
  if (planRel) {
    preparations.push({
      artifactId: "sealed-coverage-plan",
      digest: "",
      kind: "receipt",
      preparationId: "sealed-plan",
      relativePath: planRel,
      role: "coverage_plan",
      sourceDirectory: path.join(runDir, planRel),
    });
  }
  // Fallback: analysis/ under run dir when node_outputs not yet bound in unit tests.
  if (preparations.length === 0) {
    preparations.push({
      artifactId: "analysis-fallback",
      digest: "",
      kind: "receipt",
      preparationId: "analysis",
      relativePath: "analysis",
      role: "coverage_inventory",
      sourceDirectory: path.join(runDir, "analysis"),
    });
    preparations.push({
      artifactId: "analysis-plan-fallback",
      digest: "",
      kind: "receipt",
      preparationId: "analysis-plan",
      relativePath: "analysis",
      role: "coverage_plan",
      sourceDirectory: path.join(runDir, "analysis"),
    });
  }
  return loadCoverageForPlanScoutSelection({
    rootPath: input.rootPath,
    runId: input.runId,
    preparations,
  });
}

/** Prefer inventory sources; fall back to pinned_sources_json length. */
function resolveDiscoverSourceCount(
  host: { db: DatabaseSync },
  runId: string,
  inventory?: CoverageInventory,
): number {
  if (inventory?.sources?.length) return inventory.sources.length;
  const run = asRow(
    host.db.prepare("SELECT pinned_sources_json FROM runs WHERE run_id = ?").get(runId),
  );
  if (run?.pinned_sources_json != null && run.pinned_sources_json !== "") {
    try {
      const pinned = JSON.parse(String(run.pinned_sources_json)) as unknown;
      if (Array.isArray(pinned)) return pinned.length;
    } catch {
      // ignore
    }
  }
  return 0;
}

/** Load orchestration from the StartRun freeze_config snapshot. */
export function loadRunOrchestration(
  host: { db: DatabaseSync },
  runId: string,
): WorkspaceOrchestration {
  const run = asRow(
    host.db.prepare("SELECT freeze_config_json FROM runs WHERE run_id = ?").get(runId),
  );
  if (!run || run.freeze_config_json == null) {
    return resolveOrchestration(undefined);
  }
  try {
    const raw = parseJson<unknown>(String(run.freeze_config_json));
    // Full workspace snapshot (normal StartRun path).
    try {
      const workspace = WorkspaceConfigSchema.parse(raw);
      return resolveOrchestration(workspace.orchestration);
    } catch {
      // Partial freeze_config or test fixtures: accept orchestration fragment.
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as { orchestration?: unknown };
        if (obj.orchestration && typeof obj.orchestration === "object") {
          return resolveOrchestration(
            obj.orchestration as Partial<WorkspaceOrchestration>,
          );
        }
      }
      return resolveOrchestration(undefined);
    }
  } catch {
    return resolveOrchestration(undefined);
  }
}

function readJsonFromArtifactRoot(
  roots: string[],
  fileName: string,
): unknown | undefined {
  for (const root of roots) {
    if (!root) continue;
    for (const candidate of [
      path.join(root, fileName),
      root,
      path.join(root, "analysis", fileName),
    ]) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      } catch {
        // try next
      }
    }
  }
  return undefined;
}

/**
 * Resolve sealed coverage inventory/plan from freeze preparations (live sourceDir
 * or sealed relative_path under run work dir).
 */
export function loadCoverageForPlanScoutSelection(input: {
  rootPath: string;
  runId: string;
  preparations: readonly ArtifactPreparation[];
}): { inventory?: CoverageInventory; coveragePlan?: CoveragePlan } {
  const runDir = runWorkDir(input.rootPath, input.runId);
  let inventory: CoverageInventory | undefined;
  let coveragePlan: CoveragePlan | undefined;

  for (const prep of input.preparations) {
    const roots = [
      prep.sourceDirectory,
      path.join(runDir, prep.relativePath),
    ].filter((p) => typeof p === "string" && p.length > 0);

    if (prep.role === "coverage_inventory" && !inventory) {
      const raw = readJsonFromArtifactRoot(roots, COVERAGE_INVENTORY_FILE);
      if (raw !== undefined) inventory = parseSealedCoverageInventory(raw);
    }
    if (prep.role === "coverage_plan" && !coveragePlan) {
      const raw = readJsonFromArtifactRoot(roots, COVERAGE_PLAN_FILE);
      if (raw !== undefined) coveragePlan = parseSealedCoveragePlan(raw);
    }
  }

  return { inventory, coveragePlan };
}

/**
 * Select plan scout tasks for a freeze commit (pure selection + sealed coverage).
 * Throws when multi-source surveys exceed planSurveyTaskBudget (fail-closed).
 */
export function selectPlanScoutTasksForFreeze(input: {
  rootPath: string;
  runId: string;
  preparations: readonly ArtifactPreparation[];
  orch?: WorkspaceOrchestration;
  db?: DatabaseSync;
}): PlanScoutTask[] {
  const orch =
    input.orch ??
    (input.db
      ? loadRunOrchestration({ db: input.db }, input.runId)
      : resolveOrchestration(undefined));
  const { inventory, coveragePlan } = loadCoverageForPlanScoutSelection({
    rootPath: input.rootPath,
    runId: input.runId,
    preparations: input.preparations,
  });
  return selectPlanScoutTasks({
    orch,
    coverageInventory: inventory,
    coveragePlan,
  });
}

// ---------------------------------------------------------------------------
// Plan coverage / semantic sufficiency re-scout (ADR 0040 / 0042 control-plane)
// ---------------------------------------------------------------------------

/**
 * Message patterns that identify synthesizer coverage or semantic sufficiency
 * gaps (not transport/transient). Nested agent re-scout is gone — host re-arms.
 */
export const PLAN_SUFFICIENCY_GAP_MESSAGE_PATTERNS: readonly RegExp[] = [
  /coverage\s+gap/i,
  /coverage\s+gate\s+failed/i,
  /plan\s+coverage\s+gaps/i,
  /semantic\s+sufficiency/i,
  /semantic\s+gap/i,
  /\bCOVERAGE_GAP\b/,
  /\bSEMANTIC_GAP\b/,
];

/** Failure classes that must never trigger plan re-scout (transport / operator). */
const PLAN_RESCOUT_DENY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "transient",
  "capacity",
  "budget",
  "policy",
  "cancelled",
  "cancel",
  "provider",
  "publication_conflict",
]);

export type PlanRescoutControl = DagControl & {
  db: DatabaseSync;
  applyRerunAt(
    runId: string,
    nodeKey: string,
    generation: number,
    feedback?: string,
    opts?: { selfOnly?: boolean },
  ): void;
};

/** True when the plan Attempt failed for coverage / semantic sufficiency (not transport). */
export function isPlanSufficiencyGapFailure(
  kind: string,
  message: string,
  failureClass?: string,
  error?: unknown,
): boolean {
  if (kind !== "plan") return false;
  const cls = failureClass?.trim().toLowerCase();
  if (cls && PLAN_RESCOUT_DENY_FAILURE_CLASSES.has(cls)) return false;

  if (error && typeof error === "object") {
    const name = "name" in error && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "";
    if (name === "CoverageAssertError" || name === "SemanticSufficiencyError") return true;
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "";
    if (code === "COVERAGE_GAP" || code === "SEMANTIC_GAP") return true;
  }

  return PLAN_SUFFICIENCY_GAP_MESSAGE_PATTERNS.some((p) => p.test(message));
}

/**
 * Extract gap unit ids from CoverageAssertError/SemanticSufficiencyError result
 * or from synthesizer gap messages (`gap(s): a, b`).
 */
export function extractPlanSufficiencyGapUnitIds(
  message: string,
  error?: unknown,
): string[] {
  if (error && typeof error === "object" && "result" in error) {
    const result = (error as { result?: { gaps?: unknown } }).result;
    if (result && Array.isArray(result.gaps)) {
      const fromResult = result.gaps
        .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
        .map((g) => g.trim());
      if (fromResult.length > 0) return [...new Set(fromResult)];
    }
  }

  const match = message.match(/gap\(s\):\s*([^\n(+]+)/i);
  if (match?.[1]) {
    const ids = match[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/^semantic gap$/i.test(s));
    if (ids.length > 0) return [...new Set(ids)];
  }

  // Semantic: "semantic sufficiency gap: a, b" / "semantic sufficiency: …"
  const semantic = message.match(
    /semantic sufficiency(?:\s+gap)?[:\s]+([^\n(+]+)/i,
  );
  if (semantic?.[1]) {
    const ids = semantic[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/requires|multi-source/i.test(s));
    if (ids.length > 0) return [...new Set(ids)];
  }

  return [];
}

/** Max planSufficiencyRound already recorded on any plan generation (0 = never re-armed). */
export function planSufficiencyRoundsUsed(
  host: Pick<DagControl, "db">,
  runId: string,
): number {
  const rows = asRows(
    host.db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan'",
      )
      .all(runId),
  );
  let max = 0;
  for (const row of rows) {
    const raw = row.detail_json;
    if (raw == null || raw === "") continue;
    try {
      const parsed = JSON.parse(String(raw)) as { planSufficiencyRound?: unknown };
      if (
        typeof parsed.planSufficiencyRound === "number" &&
        Number.isFinite(parsed.planSufficiencyRound) &&
        parsed.planSufficiencyRound > max
      ) {
        max = Math.floor(parsed.planSufficiencyRound);
      }
    } catch {
      // ignore corrupt detail
    }
  }
  return max;
}

/** True when this run has scout topology (not light freeze→plan). */
export function hasPlanScoutTopology(
  host: Pick<DagControl, "db">,
  runId: string,
): boolean {
  return Boolean(
    asRow(
      host.db
        .prepare(
          `SELECT 1 AS present FROM nodes
           WHERE run_id = ? AND (
             kind = 'plan.discover.reduce'
             OR kind = 'plan.scout'
             OR node_key = 'plan.discover.reduce'
           )
           LIMIT 1`,
        )
        .get(runId),
    ),
  );
}

function isRealCoverageUnitGapId(id: string): boolean {
  const t = id.trim();
  // Semantic meta-gaps are not CoverageUnit ids.
  if (!t || t.startsWith("_")) return false;
  return true;
}

/** Existing durable plan.scout tasks (unit/semantic preferred; else all). */
function existingPlanScoutTasks(
  host: Pick<DagControl, "db" | "currentNodeGeneration">,
  runId: string,
): PlanScoutTask[] {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT node_key, detail_json, generation FROM nodes
         WHERE run_id = ? AND kind = 'plan.scout'
         ORDER BY node_key, generation DESC`,
      )
      .all(runId),
  );
  const seen = new Set<string>();
  const unitSemantic: PlanScoutTask[] = [];
  const all: PlanScoutTask[] = [];
  for (const row of rows) {
    const nodeKey = String(row.node_key ?? "");
    if (!nodeKey || seen.has(nodeKey)) continue;
    // Only consider current generation row once per key (ORDER BY gen DESC).
    const live = host.currentNodeGeneration(runId, nodeKey);
    if (live !== undefined && Number(row.generation) !== live) continue;
    seen.add(nodeKey);
    let detail: Record<string, unknown> = {};
    if (row.detail_json != null && row.detail_json !== "") {
      try {
        const parsed = JSON.parse(String(row.detail_json)) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        detail = {};
      }
    }
    try {
      const task = planScoutTaskFromDetail({
        scoutKind: typeof detail.scoutKind === "string" ? detail.scoutKind : undefined,
        unitId: typeof detail.unitId === "string" ? detail.unitId : undefined,
        sourceId: typeof detail.sourceId === "string" ? detail.sourceId : undefined,
        surfacePath:
          typeof detail.surfacePath === "string" ? detail.surfacePath : undefined,
        critical: typeof detail.critical === "boolean" ? detail.critical : undefined,
        taskLabel: typeof detail.taskLabel === "string" ? detail.taskLabel : undefined,
      });
      all.push(task);
      if (task.kind !== "thematic") unitSemantic.push(task);
    } catch {
      // Skip unparseable scout detail.
    }
  }
  return unitSemantic.length > 0 ? unitSemantic : all;
}

function demoteNodeState(
  host: Pick<DagControl, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
  state: "blocked" | "invalidated",
): void {
  host.db
    .prepare(
      `UPDATE nodes SET state = ?, current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ?
         AND state IN ('ready', 'blocked', 'invalidated')`,
    )
    .run(state, runId, nodeKey, generation);
}

function mergePlanDetailRound(
  host: Pick<DagControl, "db">,
  runId: string,
  generation: number,
  nextRound: number,
  gapUnitIds: readonly string[],
): void {
  const row = asRow(
    host.db
      .prepare(
        "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = ?",
      )
      .get(runId, generation),
  );
  let base: Record<string, unknown> = {};
  if (row?.detail_json != null && row.detail_json !== "") {
    try {
      const parsed = JSON.parse(String(row.detail_json)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      base = {};
    }
  }
  base.planSufficiencyRound = nextRound;
  if (gapUnitIds.length > 0) base.planSufficiencyGaps = [...gapUnitIds];
  host.db
    .prepare(
      `UPDATE nodes SET detail_json = ?
       WHERE run_id = ? AND node_key = 'plan' AND generation = ?`,
    )
    .run(JSON.stringify(base), runId, generation);
}

/**
 * Control-plane re-arm after plan coverage/semantic gap (ADR 0040/0042).
 *
 * When budget remains (`planRescoutMaxRounds`): bump gap plan.scout tasks
 * (or existing unit/semantic scouts), re-block plan.discover.reduce + plan at
 * gen+1, unlock scouts. Fail-closed when exhausted or light path (no scouts).
 *
 * @returns true when re-arm was applied (caller should emit node.ready).
 */
export function schedulePlanSufficiencyRescout(
  host: PlanRescoutControl,
  input: {
    runId: string;
    planGeneration: number;
    message: string;
    failureClass?: string;
    error?: unknown;
  },
): boolean {
  const { runId, planGeneration, message, failureClass, error } = input;
  if (
    !isPlanSufficiencyGapFailure("plan", message, failureClass, error)
  ) {
    return false;
  }
  if (!hasPlanScoutTopology(host, runId)) {
    // Light path: no scouts to re-arm — fail closed as today.
    return false;
  }

  const orch = loadRunOrchestration(host, runId);
  const maxRounds = orch.planRescoutMaxRounds;
  if (maxRounds <= 0) return false;

  const used = planSufficiencyRoundsUsed(host, runId);
  if (used >= maxRounds) return false;

  const nextRound = used + 1;
  const rawGaps = extractPlanSufficiencyGapUnitIds(message, error);
  const unitGaps = rawGaps.filter(isRealCoverageUnitGapId);

  let tasks: PlanScoutTask[] = [];
  if (unitGaps.length > 0) {
    try {
      tasks = selectPlanScoutTasks({
        orch,
        gapUnitIds: unitGaps,
      });
    } catch {
      tasks = [];
    }
  }
  if (tasks.length === 0) {
    // Semantic meta-gaps / unparseable unit list → re-arm existing unit/semantic scouts.
    tasks = existingPlanScoutTasks(host, runId);
  }
  if (tasks.length === 0) {
    // Topology claimed scouts exist but none parseable — still bump reduce+plan only if
    // at least one plan.scout node key is known.
    const anyScout = asRow(
      host.db
        .prepare(
          `SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan.scout' LIMIT 1`,
        )
        .get(runId),
    );
    if (!anyScout) return false;
  }

  const feedback = [
    `Plan sufficiency re-scout round ${nextRound}/${maxRounds}`,
    unitGaps.length > 0 ? `gaps: ${unitGaps.slice(0, 12).join(", ")}` : message.slice(0, 500),
  ].join("\n");

  // 1) Re-arm gap / selected scouts (selfOnly — reduce/plan bumped explicitly).
  for (const task of tasks) {
    const nodeKey = planScoutNodeKey(task);
    const gen = host.currentNodeGeneration(runId, nodeKey);
    if (gen === undefined) {
      // Insert new gap scout at generation 0 if freeze already succeeded.
      contractForNode("plan.scout", nodeKey);
      const detail = planScoutDetailFromTask(task);
      host.db
        .prepare(
          `INSERT INTO nodes (
            run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
          ) VALUES (?, ?, 'plan.scout', 'ready', 0, NULL, NULL, ?)`,
        )
        .run(runId, nodeKey, JSON.stringify(detail));
      host.db
        .prepare(
          `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'freeze', ?)
           ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
        )
        .run(runId, nodeKey);
      host.db
        .prepare(
          `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
           ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
        )
        .run(runId, nodeKey, DISCOVER_REDUCE_KEY);
      continue;
    }
    try {
      host.applyRerunAt(runId, nodeKey, gen, undefined, { selfOnly: true });
    } catch {
      // already bumped / stale — continue
    }
  }

  // 2) Re-arm plan.discover.reduce → blocked until scouts terminal.
  const reduceGen = host.currentNodeGeneration(runId, DISCOVER_REDUCE_KEY);
  if (reduceGen !== undefined) {
    try {
      host.applyRerunAt(runId, DISCOVER_REDUCE_KEY, reduceGen, undefined, {
        selfOnly: true,
      });
    } catch {
      // ignore
    }
    const nextReduceGen = host.currentNodeGeneration(runId, DISCOVER_REDUCE_KEY);
    if (nextReduceGen !== undefined) {
      demoteNodeState(host, runId, DISCOVER_REDUCE_KEY, nextReduceGen, "blocked");
    }
  }

  // 3) Re-arm plan at gen+1, blocked until reduce succeeds; stamp round counter.
  try {
    host.applyRerunAt(runId, "plan", planGeneration, feedback, { selfOnly: true });
  } catch {
    return false;
  }
  const nextPlanGen = host.currentNodeGeneration(runId, "plan");
  if (nextPlanGen === undefined) return false;
  demoteNodeState(host, runId, "plan", nextPlanGen, "blocked");
  mergePlanDetailRound(host, runId, nextPlanGen, nextRound, unitGaps.length > 0 ? unitGaps : rawGaps);

  unlockReadyNodes(host, runId);

  // Scouts that were inserted ready stay ready; applyRerunAt roots are ready.
  // Ensure run is claimable.
  host.db
    .prepare(
      "UPDATE runs SET state = 'queued', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(now(), runId);

  return true;
}

