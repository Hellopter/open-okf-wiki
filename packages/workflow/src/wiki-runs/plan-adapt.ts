/**
 * Bounded evidence-gap adaptation for the fixed WikiRuns product graph.
 * The model may propose leaf research only; the host validates and derives all
 * durable nodes and edges. This is deliberately not a workflow DSL.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { contractForNode, type ExecutionPlanDelta, ExecutionPlanDeltaSchema, type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract/wiki-runs";
import { runWorkDir } from "@okf-wiki/core";
import type { WikiRunsDbCtx } from "./ctx.js";
import { loadExecutionPlanFromPlanNode } from "./dag.js";
import { asRow, asRows, requiredText } from "./sql.js";
import type { ArtifactPreparation, ClaimedNode } from "./types.js";

export function planAdaptNodeKey(round: number): string {
  return `plan.adapt.${round}`;
}

export function planAdaptRound(nodeKey: string): number | undefined {
  const match = /^plan\.adapt\.([1-2])$/.exec(nodeKey);
  return match ? Number(match[1]) : undefined;
}

function loadDelta(preparation: ArtifactPreparation | undefined): ExecutionPlanDelta {
  if (!preparation || preparation.role !== "plan_delta") {
    throw new Error("plan adaptation succeeded without a plan_delta artifact");
  }
  try {
    const raw = readFileSync(
      path.join(preparation.sourceDirectory, "execution-plan-delta.json"),
      "utf8",
    );
    return ExecutionPlanDeltaSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `plan adaptation delta is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadSpec(host: Pick<WikiRunsDbCtx, "db" | "workspace">, runId: string): WikiRunSpec {
  const output = asRow(
    host.db
      .prepare(
        `SELECT artifacts.relative_path
         FROM node_outputs
         JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
         WHERE node_outputs.run_id = ? AND node_outputs.node_key = 'plan'
           AND node_outputs.role = 'spec'
         ORDER BY node_outputs.node_generation DESC LIMIT 1`,
      )
      .get(runId),
  );
  if (!output) throw new Error("plan adaptation requires a sealed Spec");
  try {
    const raw = readFileSync(
      path.join(
        runWorkDir(host.workspace.rootPath, runId),
        requiredText(output, "relative_path"),
        "spec.json",
      ),
      "utf8",
    );
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `plan adaptation cannot read sealed Spec: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function existingLeafState(
  host: Pick<WikiRunsDbCtx, "db">,
  runId: string,
): {
  byDomain: Map<string, number>;
  workUnitIds: Set<string>;
} {
  const byDomain = new Map<string, number>();
  const workUnitIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const row of asRows(
    host.db
      .prepare(
        `SELECT node_key, detail_json FROM nodes
         WHERE run_id = ? AND kind = 'research.leaf' ORDER BY node_key, generation`,
      )
      .all(runId),
  )) {
    const key = requiredText(row, "node_key");
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    try {
      const detail = JSON.parse(String(row.detail_json ?? "{}")) as Record<string, unknown>;
      if (typeof detail.domainId === "string" && detail.domainId.trim()) {
        const domainId = detail.domainId.trim();
        byDomain.set(domainId, (byDomain.get(domainId) ?? 0) + 1);
      }
      if (typeof detail.workUnitId === "string" && detail.workUnitId.trim()) {
        workUnitIds.add(detail.workUnitId.trim());
      }
    } catch {
      throw new Error(`plan adaptation cannot trust malformed research detail: ${key}`);
    }
  }
  return { byDomain, workUnitIds };
}

/** Validate the proposed delta before the successful attempt is committed. */
export function validatePlanAdaptation(
  host: Pick<WikiRunsDbCtx, "db" | "workspace">,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
): ExecutionPlanDelta {
  const round = planAdaptRound(claim.nodeKey);
  if (claim.kind !== "plan.adapt" || round === undefined) {
    throw new Error(`invalid plan adaptation claim: ${claim.kind}/${claim.nodeKey}`);
  }
  const delta = loadDelta(preparations.find((item) => item.role === "plan_delta"));
  const plan = loadExecutionPlanFromPlanNode(host, claim.runId);
  if (!plan) throw new Error("plan adaptation requires a sealed execution plan");
  if (round > plan.adaptation.maxRounds)
    throw new Error("plan adaptation round exceeds frozen cap");
  if (!delta.complete && round >= plan.adaptation.maxRounds) {
    throw new Error("plan adaptation reached its frozen round cap; mark the delta complete");
  }
  const writeStarted = asRow(
    host.db
      .prepare(
        "SELECT 1 AS present FROM attempts WHERE run_id = ? AND node_key = 'write.root' LIMIT 1",
      )
      .get(claim.runId),
  );
  if (writeStarted) throw new Error("plan adaptation is forbidden after writing starts");

  const spec = loadSpec(host, claim.runId);
  const domainIds = new Set(spec.domains.map((domain) => domain.id));
  const existing = existingLeafState(host, claim.runId);
  const proposedIds = new Set<string>();
  const nextByDomain = new Map(existing.byDomain);
  for (const addition of delta.additions) {
    if (!domainIds.has(addition.domainId)) {
      throw new Error(`plan adaptation references unknown domain: ${addition.domainId}`);
    }
    if (proposedIds.has(addition.id) || existing.workUnitIds.has(addition.id)) {
      throw new Error(`plan adaptation work unit id is not unique: ${addition.id}`);
    }
    proposedIds.add(addition.id);
    const next = (nextByDomain.get(addition.domainId) ?? 0) + 1;
    if (next > plan.fanOut.maxLeafFanOut) {
      throw new Error(
        `plan adaptation exceeds remaining leaf fan-out for domain ${addition.domainId}`,
      );
    }
    nextByDomain.set(addition.domainId, next);
  }
  return delta;
}

/** Materialize only host-derived, acyclic additions after a validated adaptation. */
export function materializePlanAdaptation(
  host: Pick<WikiRunsDbCtx, "db" | "workspace">,
  claim: ClaimedNode,
  delta: ExecutionPlanDelta,
): void {
  const round = planAdaptRound(claim.nodeKey);
  if (round === undefined) throw new Error(`invalid plan adaptation key: ${claim.nodeKey}`);
  const plan = loadExecutionPlanFromPlanNode(host, claim.runId);
  if (!plan) throw new Error("plan adaptation requires a sealed execution plan");
  const existing = existingLeafState(host, claim.runId);
  const indexes = new Map(existing.byDomain);
  const nextAdapt = !delta.complete ? planAdaptNodeKey(round + 1) : undefined;

  if (nextAdapt) {
    contractForNode("plan.adapt", nextAdapt);
    host.db
      .prepare(
        `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
         VALUES (?, ?, 'plan.adapt', 'blocked', 0, NULL, NULL, ?)
         ON CONFLICT(run_id, node_key, generation) DO NOTHING`,
      )
      .run(claim.runId, nextAdapt, JSON.stringify({ adaptRound: round + 1 }));
    host.db
      .prepare(
        "INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(claim.runId, nextAdapt, "write.root");
  }

  for (const [offset, addition] of delta.additions.entries()) {
    const index = (indexes.get(addition.domainId) ?? 0) + 1;
    indexes.set(addition.domainId, index);
    const leafKey = `research.leaf.${addition.domainId}.adapt.${round}.${offset + 1}`;
    contractForNode("research.leaf", leafKey);
    host.db
      .prepare(
        `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
         VALUES (?, ?, 'research.leaf', 'blocked', 0, NULL, NULL, ?)`,
      )
      .run(
        claim.runId,
        leafKey,
        JSON.stringify({
          domainId: addition.domainId,
          question: addition.question,
          scope: addition.scope,
          questionIndex: index,
          workUnitId: addition.id,
          adaptRound: round,
        }),
      );
    for (const to of ["write.root", ...(nextAdapt ? [nextAdapt] : [])]) {
      host.db
        .prepare(
          "INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .run(claim.runId, leafKey, to);
    }
    host.db
      .prepare(
        "INSERT INTO node_edges (run_id, from_key, to_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(claim.runId, claim.nodeKey, leafKey);
  }
}
