/**
 * Execution graph materialize + unlock / upstream helpers.
 * Pure durable graph mechanics — no gate open/resolve control flow.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { contractForNode, type ExecutionPlan, ExecutionPlanSchema, type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { runWorkDir } from "@okf-wiki/core";
import { buildExecutionGraphFromPlan, isGateKind } from "../execution-graph.js";
import { asRow, asRows, requiredNumber, requiredText } from "./sql.js";

/** Minimal db + generation surface for unlock / upstream checks. */
export type DagControl = {
  db: DatabaseSync;
  currentNodeGeneration(runId: string, nodeKey: string): number | undefined;
};

/** Load a sealed Spec JSON from an artifact relative path under the run work dir. */
export function loadSpecFromArtifact(
  host: { workspace: WorkspaceConfig },
  runId: string,
  relativePath: string,
): WikiRunSpec | undefined {
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  try {
    const raw = readFileSync(path.join(runDir, relativePath, "spec.json"), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function planNodeKeyForGate(
  host: Pick<DagControl, "db">,
  runId: string,
  gateNodeKey: string,
): string {
  if (gateNodeKey === "gate.plan" || gateNodeKey.startsWith("gate.plan")) return "plan";
  const plan = asRow(
    host.db
      .prepare(
        `SELECT node_key FROM nodes WHERE run_id = ? AND kind = 'plan'
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(runId),
  );
  if (plan) return requiredText(plan, "node_key");
  return "plan";
}

/** Load sealed ExecutionPlan from plan node outputs when present. */
export function loadExecutionPlanFromPlanNode(
  host: { db: DatabaseSync; workspace: WorkspaceConfig },
  runId: string,
): ExecutionPlan | undefined {
  const planGen = asRow(
    host.db
      .prepare(
        `SELECT MAX(generation) AS generation FROM nodes
         WHERE run_id = ? AND node_key = 'plan'`,
      )
      .get(runId),
  );
  if (!planGen || planGen.generation == null) return undefined;
  const generation = requiredNumber(planGen, "generation");
  const output = asRow(
    host.db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         WHERE node_outputs.run_id = ?
           AND node_outputs.node_key = 'plan'
           AND node_outputs.node_generation = ?
           AND node_outputs.role = 'execution_plan'
         LIMIT 1`,
      )
      .get(runId, generation),
  );
  if (!output) return undefined;
  const runDir = runWorkDir(host.workspace.rootPath, runId);
  try {
    const raw = readFileSync(
      path.join(runDir, requiredText(output, "relative_path"), "execution-plan.json"),
      "utf8",
    );
    return ExecutionPlanSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Insert execution nodes/edges from sealed Spec and ExecutionPlan artifacts.
 * Caller sets run state and calls unlockReadyNodes + emit as needed.
 */
export function materializeExecutionGraph(
  host: { db: DatabaseSync; workspace: WorkspaceConfig },
  runId: string,
  relativePath: string,
): void {
  const spec = loadSpecFromArtifact(host, runId, relativePath);
  if (!spec) throw new Error("plan approve requires a parseable sealed Spec");
  const plan = loadExecutionPlanFromPlanNode(host, runId);
  if (!plan) throw new Error("plan approve requires a sealed execution-plan.json");
  const graph = buildExecutionGraphFromPlan(plan, spec);
  for (const node of graph.nodes) {
    const existing = asRow(
      host.db
        .prepare(
          "SELECT 1 AS present FROM nodes WHERE run_id = ? AND node_key = ? AND generation = 0",
        )
        .get(runId, node.key),
    );
    if (existing) continue;
    contractForNode(node.kind, node.key);
    // All execution graph nodes start blocked; unlockReadyNodes opens the frontier.
    const initialState = "blocked";
    host.db
      .prepare(
        `INSERT INTO nodes (
          run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json
        ) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?)`,
      )
      .run(
        runId,
        node.key,
        node.kind,
        initialState,
        node.detail ? JSON.stringify(node.detail) : null,
      );
  }
  for (const edge of graph.edges) {
    host.db
      .prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?)
         ON CONFLICT(run_id, from_key, to_key) DO NOTHING`,
      )
      .run(runId, edge.from, edge.to);
  }
}

/**
 * Promote blocked/invalidated nodes whose current-generation upstreams have all
 * succeeded. After RerunNode, invalidated gen+1 descendants re-enter ready this way.
 * Gate nodes stay blocked/waiting until their predecessor opens them explicitly.
 */
export function unlockReadyNodes(host: DagControl, runId: string): void {
  const candidates = asRows(
    host.db
      .prepare(
        `SELECT nodes.node_key, nodes.kind, nodes.generation, nodes.state
         FROM nodes
         WHERE nodes.run_id = ?
           AND nodes.state IN ('blocked', 'invalidated')
           AND nodes.generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )`,
      )
      .all(runId),
  );
  for (const row of candidates) {
    const nodeKey = requiredText(row, "node_key");
    const kind = requiredText(row, "kind");
    const generation = requiredNumber(row, "generation");
    const priorState = requiredText(row, "state");
    if (isGateKind(kind)) continue;
    if (!upstreamsSucceeded(host, runId, nodeKey)) continue;
    host.db
      .prepare(
        `UPDATE nodes SET state = 'ready', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ? AND state = ?`,
      )
      .run(runId, nodeKey, generation, priorState);
  }
}

export function upstreamKeys(host: Pick<DagControl, "db">, runId: string, nodeKey: string): string[] {
  return asRows(
    host.db
      .prepare("SELECT from_key FROM node_edges WHERE run_id = ? AND to_key = ? ORDER BY from_key")
      .all(runId, nodeKey),
  ).map((row) => requiredText(row, "from_key"));
}

/**
 * True when a plan.scout node's detail_json.critical is true.
 * Missing/invalid detail fails closed (treat as critical).
 */
export function isCriticalPlanScoutNode(
  host: Pick<DagControl, "db">,
  runId: string,
  nodeKey: string,
  generation: number,
): boolean {
  if (!nodeKey.startsWith("plan.scout.")) return true;
  const row = asRow(
    host.db
      .prepare(
        "SELECT kind, detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?",
      )
      .get(runId, nodeKey, generation),
  );
  if (!row) return true;
  if (requiredText(row, "kind") !== "plan.scout") return true;
  const raw = row.detail_json;
  if (raw == null || raw === "") return true;
  try {
    const parsed = JSON.parse(String(raw)) as { critical?: unknown };
    if (typeof parsed.critical === "boolean") return parsed.critical;
  } catch {
    return true;
  }
  return true;
}

export function upstreamsSucceeded(host: DagControl, runId: string, nodeKey: string): boolean {
  const upstreams = upstreamKeys(host, runId, nodeKey);
  // Hard-coded bootstrap edges for freeze→plan before node_edges exist.
  if (upstreams.length === 0) {
    if (nodeKey === "plan") {
      const freezeGen = host.currentNodeGeneration(runId, "freeze");
      if (freezeGen === undefined) return false;
      const freeze = asRow(
        host.db
          .prepare(
            "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'freeze' AND generation = ?",
          )
          .get(runId, freezeGen),
      );
      return Boolean(freeze && requiredText(freeze, "state") === "succeeded");
    }
    return true;
  }
  for (const fromKey of upstreams) {
    const gen = host.currentNodeGeneration(runId, fromKey);
    if (gen === undefined) return false;
    const node = asRow(
      host.db
        .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, fromKey, gen),
    );
    if (!node) return false;
    const state = requiredText(node, "state");

    // plan.discover.reduce waits for every plan.scout.* to reach a terminal state.
    // Optional scouts may fail/cancel without blocking; critical must succeed.
    // Non-terminal scouts (ready/running/blocked/…) always hold reduce closed —
    // otherwise mechanical merge could claim with empty scout receipts.
    // (Legacy: plan may still have direct scout edges from older graphs.)
    if (
      (nodeKey === "plan.discover.reduce" || nodeKey === "plan") &&
      fromKey.startsWith("plan.scout.")
    ) {
      if (state === "succeeded") continue;
      if (state === "failed" || state === "cancelled") {
        if (isCriticalPlanScoutNode(host, runId, fromKey, gen)) return false;
        continue;
      }
      // Non-terminal (blocked|ready|running|waiting|invalidated|…): wait.
      return false;
    }

    if (state !== "succeeded") return false;
  }
  return true;
}
