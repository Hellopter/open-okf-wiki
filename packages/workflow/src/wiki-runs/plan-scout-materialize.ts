/**
 * Host-owned durable plan.scout materialization after freeze.
 *
 * Topology (U1):
 *   light: freeze → plan (ready)
 *   scout: freeze → plan.scout.* → plan (blocked until all scouts terminal;
 *          critical must succeed; optional may fail/cancel)
 *
 * Task selection is pure contract code; this module only inserts nodes/edges.
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
  scoutTaskLabel,
  selectPlanScoutTasks,
} from "@okf-wiki/contract/wiki-runs";
import {
  resolveOrchestration,
  type WorkspaceOrchestration,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract/workspace";
import { runWorkDir } from "@okf-wiki/core";
import { COVERAGE_INVENTORY_FILE, COVERAGE_PLAN_FILE } from "./coverage-bridge.js";
import { unlockReadyNodes, type DagControl } from "./dag.js";
import { asRow, parseJson } from "./sql.js";
import type { ArtifactPreparation } from "./types.js";

/** detail_json shape sealed on each durable plan.scout node. */
export type PlanScoutNodeDetail = {
  scoutKind: string;
  unitId?: string;
  sourceId?: string;
  surfacePath?: string;
  critical: boolean;
  taskLabel: string;
};

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
  return {
    scoutKind: "surface",
    sourceId: task.sourceId,
    surfacePath: task.path,
    unitId: task.unitId,
    critical: task.required,
    taskLabel,
  };
}

/**
 * Insert durable plan.scout.* nodes + edges, or light-path freeze→plan.
 * Idempotent for node keys already present (pin retry / recovery).
 *
 * @returns selected tasks (empty on light path)
 */
export function materializePlanScoutsAfterFreeze(
  host: DagControl & { db: DatabaseSync },
  runId: string,
  tasks: readonly PlanScoutTask[],
): PlanScoutTask[] {
  const existingPlan = asRow(
    host.db
      .prepare(
        "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'plan' AND generation = 0",
      )
      .get(runId),
  );

  if (tasks.length === 0) {
    // Light path: freeze → plan ready.
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

  // Scout path: freeze → each scout → plan (blocked).
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
          ) VALUES (?, ?, 'plan.scout', 'blocked', 0, NULL, NULL, ?)`,
        )
        .run(runId, nodeKey, JSON.stringify(detail));
    }
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, 'freeze', ?)
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId, nodeKey);
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, 'plan')
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId, nodeKey);
  }

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
    // Pin retry: keep plan blocked until scouts finish (do not force ready).
    host.db
      .prepare(
        `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = 'plan' AND generation = 0
           AND state IN ('ready', 'invalidated', 'failed')`,
      )
      .run(runId);
  }

  unlockReadyNodes(host, runId);
  return [...tasks];
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
    const workspace = WorkspaceConfigSchema.parse(
      parseJson<unknown>(String(run.freeze_config_json)),
    );
    return resolveOrchestration(workspace.orchestration);
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

