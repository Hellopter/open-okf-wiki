/**
 * Single post-success entry after a sealed attempt CAS commit.
 * Owns gate open / plan auto-approve / unlock / run-state transitions that used
 * to live inside commitNodeArtifacts (artifacts stays bytes+CAS only).
 * Also owns prepared-artifact recovery (CAS + control-flow in one path).
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttemptMetrics } from "@okf-wiki/contract";
import {
  planUncertaintyFromSpec,
  resolveAdaptiveOrchestration,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import { runWorkDir } from "@okf-wiki/core";
import { compileExecutionPlan } from "../plan-compiler.js";
import {
  type ArtifactsHost,
  commitNodeArtifacts,
  loadSealedDefectsReport,
  prepareUnsealedArtifact,
  verifyArtifact,
} from "./artifacts.js";
import { digest, now } from "./crypto-util.js";
import type { WikiRunsCasCtx, WikiRunsDbCtx } from "./ctx.js";
import { unlockReadyNodes } from "./dag.js";
import { commitFreezeArtifacts, type FreezeCommitHost, trustedFrozenInputs } from "./freeze.js";
import {
  autoPassFixGate,
  openFixGate,
  openPlanGate,
  openPublicationGate,
  readPublicationBaseline,
} from "./gate-open.js";
import { onPlanAccepted } from "./gate-resolve.js";
import { planGateDetailFromSpec, planGatePayloadDigest } from "./plan-review.js";
import { materializePlanAdaptation, validatePlanAdaptation } from "./plan-adapt.js";
import {
  isRepairNodeKey,
  loadAcceptance,
  rearmEvaluationRoundAfterRepair,
  scheduleAutomaticSemanticRepair,
} from "./repair-schedule.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import type { ArtifactPreparation, ClaimedFreeze, ClaimedNode } from "./types.js";

/**
 * Host for successful-attempt side effects (gates + unlock + plan accept).
 * CAS checks without requiring transaction on every call site.
 */
export type AttemptSuccessHost = WikiRunsDbCtx &
  Pick<WikiRunsCasCtx, "isCurrent" | "currentNodeGeneration"> & {
    /**
     * Durable RerunNode core — required to re-arm EvaluationRound after any repair.N.
     * Optional only for unit hosts that never exercise repair success.
     */
    applyRerunAt?(
      runId: string,
      nodeKey: string,
      generation: number,
      feedback?: string,
      opts?: { selfOnly?: boolean; excludeConsumer?: (nodeKey: string) => boolean },
    ): void;
  };

/** Recovery needs transaction + the success host surface. */
export type RecoverArtifactsHost = AttemptSuccessHost & Pick<ArtifactsHost, "transaction">;

function freezeCommitHost(host: AttemptSuccessHost): FreezeCommitHost {
  return {
    db: host.db,
    isCurrent: (claim) => host.isCurrent(claim),
    emit: (runId, type) => host.emit(runId, type),
  };
}

function orphanPreparedGroup(host: RecoverArtifactsHost, attemptId: string): void {
  host.transaction(() =>
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(attemptId),
  );
}

/**
 * ADR 0035 recovery: replay only prepared, verified artifacts whose Attempt is
 * still current (`isCurrent` inside commit). Route by preparation `node_key`:
 * freeze → `commitFreezeArtifacts`; all other nodes → `commitSuccessfulAttempt`
 * (CAS + gate open / unlock / plan accept).
 */
export async function recoverPreparedArtifacts(host: RecoverArtifactsHost): Promise<void> {
  const rows = asRows(
    host.db
      .prepare(
        `SELECT preparation_id, attempt_id, run_id, node_key, node_generation, artifact_id, kind, role,
                manifest_digest, relative_path
         FROM artifact_preparations WHERE state = 'prepared' ORDER BY attempt_id, preparation_id`,
      )
      .all(),
  );
  const grouped = new Map<string, SqlRow[]>();
  for (const row of rows) {
    const attemptId = requiredText(row, "attempt_id");
    grouped.set(attemptId, [...(grouped.get(attemptId) ?? []), row]);
  }
  for (const [attemptId, preparations] of grouped) {
    const first = preparations[0]!;
    const runId = requiredText(first, "run_id");
    const nodeKey = requiredText(first, "node_key");
    const nodeGeneration = requiredNumber(first, "node_generation");
    const valid = await Promise.all(
      preparations.map((preparation) =>
        verifyArtifact(
          path.join(
            runWorkDir(host.workspace.rootPath, runId),
            requiredText(preparation, "relative_path"),
          ),
          requiredText(preparation, "manifest_digest"),
        ),
      ),
    );
    if (!valid.every(Boolean)) {
      orphanPreparedGroup(host, attemptId);
      continue;
    }
    const prepared: ArtifactPreparation[] = preparations.map((preparation) => ({
      artifactId: requiredText(preparation, "artifact_id"),
      digest: requiredText(preparation, "manifest_digest"),
      kind: requiredText(preparation, "kind") as ArtifactPreparation["kind"],
      preparationId: requiredText(preparation, "preparation_id"),
      relativePath: requiredText(preparation, "relative_path"),
      role: requiredText(preparation, "role"),
      sourceDirectory: "",
    }));

    if (nodeKey === "freeze") {
      // Freeze commit also pins frozen_* → pinned_*; require attempt_output + durable freeze inputs.
      const output = preparations.find(
        (preparation) => requiredText(preparation, "role") === "attempt_output",
      );
      if (!output) {
        orphanPreparedGroup(host, attemptId);
        continue;
      }
      const inputs = trustedFrozenInputs({ db: host.db }, runId);
      if (!inputs) {
        orphanPreparedGroup(host, attemptId);
        continue;
      }
      const claim: ClaimedFreeze = {
        attemptId,
        nodeGeneration,
        nodeKey: "freeze",
        kind: "freeze",
        runId,
      };
      host.transaction(() => commitFreezeArtifacts(freezeCommitHost(host), claim, prepared));
      continue;
    }

    // Non-freeze prepared groups: rebuild claim from the node row and commit via
    // the same CAS + control-flow path as live execution.
    const node = asRow(
      host.db
        .prepare("SELECT kind FROM nodes WHERE run_id = ? AND node_key = ? AND generation = ?")
        .get(runId, nodeKey, nodeGeneration),
    );
    if (!node) {
      orphanPreparedGroup(host, attemptId);
      continue;
    }
    const claim: ClaimedNode = {
      attemptId,
      nodeGeneration,
      nodeKey,
      kind: requiredText(node, "kind"),
      runId,
    };
    host.transaction(() => commitSuccessfulAttempt(host, claim, prepared));
  }
}

/**
 * Control-flow after CAS seal of a successful attempt (same transaction).
 * Caller must have already run commitNodeArtifacts (or use commitSuccessfulAttempt).
 */
export function onAttemptSucceeded(
  host: AttemptSuccessHost,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
  timestamp: string = now(),
  planDelta?: ReturnType<typeof validatePlanAdaptation>,
): void {
  if (claim.kind === "plan") {
    const specPrep = preparations.find((item) => item.role === "spec" || item.kind === "spec");
    if (!specPrep) throw new Error("plan attempt succeeded without a Spec artifact");
    const planPrep = preparations.find(
      (item) => item.role === "execution_plan" || item.kind === "execution_plan",
    );
    if (!planPrep) {
      throw new Error("plan attempt succeeded without an ExecutionPlan artifact");
    }
    // Gate payload binds Spec digest + ExecutionPlan digest (Phase 1 hard-cut).
    const payloadDigest = planGatePayloadDigest(specPrep.digest, planPrep.digest);
    // planConfirm=false: auto-approve — same onPlanAccepted path as ResolveGate approve.
    if (host.workspaceForRun(claim.runId).planConfirm === false) {
      onPlanAccepted(host, claim.runId, specPrep.relativePath, timestamp);
      return;
    }
    const workspace = host.workspaceForRun(claim.runId);
    let planDetail: ReturnType<typeof planGateDetailFromSpec> | undefined;
    try {
      const runDir = runWorkDir(workspace.rootPath, claim.runId);
      const raw = readFileSync(path.join(runDir, specPrep.relativePath, "spec.json"), "utf8");
      const sealedSpec = WikiRunSpecSchema.parse(JSON.parse(raw));
      planDetail = planGateDetailFromSpec(sealedSpec);
    } catch {
      // Gate still opens; operator loads full Spec via plan-review API.
    }
    openPlanGate(host, claim, payloadDigest, timestamp, planDetail);
    return;
  }
  if (claim.kind === "prepare.publication") {
    const candidate = preparations.find(
      (item) => item.role === "publication_candidate" || item.kind === "publication_candidate",
    );
    if (!candidate) throw new Error("prepare.publication succeeded without a candidate");
    const expectedLiveDigest = readPublicationBaseline(host, claim.runId, preparations);
    openPublicationGate(host, claim, candidate, expectedLiveDigest, timestamp);
    return;
  }
  if (claim.kind === "review.reduce") {
    // Open gate.fix when any defect severity is in Spec acceptance.blockingSeverities
    // (default ["blocking"]). Otherwise auto-pass. Fail-closed reduce never invents clean.
    const defectsPrep = preparations.find((item) => item.role === "defects");
    const report = loadSealedDefectsReport(host, claim.runId, defectsPrep);
    const acceptance = loadAcceptance(host, claim.runId);
    const blockingSeverities =
      acceptance?.blockingSeverities && acceptance.blockingSeverities.length > 0
        ? acceptance.blockingSeverities
        : (["blocking"] as const);
    const severitySet = new Set(blockingSeverities);
    const blocking = report?.defects.filter((d) => severitySet.has(d.severity)) ?? [];
    if (blocking.length === 0) {
      autoPassFixGate(host, claim.runId, timestamp);
      return;
    }
    if (
      acceptance?.autoRepair !== false &&
      typeof host.applyRerunAt === "function" &&
      scheduleAutomaticSemanticRepair(
        {
          db: host.db,
          workspace: host.workspaceForRun(claim.runId),
          emit: host.emit,
          currentNodeGeneration: (runId, nodeKey) => host.currentNodeGeneration(runId, nodeKey),
          applyRerunAt: (runId, nodeKey, generation, feedback, opts) =>
            host.applyRerunAt!(runId, nodeKey, generation, feedback, opts),
        },
        claim,
        timestamp,
      )
    ) {
      return;
    }
    const payloadDigest =
      defectsPrep?.digest ?? digest(report ?? { clean: false, defects: blocking });
    openFixGate(host, claim, payloadDigest, timestamp, {
      summary: report?.summary,
      clean: false,
      blockingCount: blocking.length,
    });
    return;
  }
  if (claim.kind === "publish") {
    host.db
      .prepare(
        "UPDATE runs SET state = 'published', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
    host.emit(claim.runId, "run.published");
    return;
  }

  if (claim.kind === "plan.adapt") {
    if (!planDelta) throw new Error("plan adaptation succeeded without a validated delta");
    materializePlanAdaptation(host, claim, planDelta);
  }

  // ANY repair.N success → full EvaluationRound re-arm (validate.pre + seats + reduce).
  // gate.fix / validate.final were already held at schedule time.
  if (
    (isRepairNodeKey(claim.nodeKey) ||
      (claim.kind === "repair" && claim.nodeKey.startsWith("repair."))) &&
    typeof host.applyRerunAt === "function"
  ) {
    rearmEvaluationRoundAfterRepair(
      {
        db: host.db,
        workspace: host.workspaceForRun(claim.runId),
        emit: host.emit,
        currentNodeGeneration: (runId, nodeKey) => host.currentNodeGeneration(runId, nodeKey),
        applyRerunAt: (runId, nodeKey, generation, feedback, opts) =>
          host.applyRerunAt!(runId, nodeKey, generation, feedback, opts),
      },
      claim.runId,
    );
  }

  unlockReadyNodes(host, claim.runId);
  const hasReady = asRow(
    host.db
      .prepare(
        `SELECT 1 AS present FROM nodes
         WHERE run_id = ? AND state = 'ready'
           AND generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         LIMIT 1`,
      )
      .get(claim.runId),
  );
  // Open gates table is the HITL authority — do not treat stale gate.* nodes
  // left in state='waiting' after Rerun/withdraw as operator waits (parallel
  // seat commits used to flip the run to waiting_for_operator and stall).
  const hasOpenGate = asRow(
    host.db
      .prepare(`SELECT 1 AS present FROM gates WHERE run_id = ? AND state = 'open' LIMIT 1`)
      .get(claim.runId),
  );
  if (hasReady) {
    // Ready work wins over a stale waiting_for_operator (e.g. withdrawn pub gate
    // node still marked waiting while review.reduce is ready).
    host.db
      .prepare(
        `UPDATE runs SET state = 'queued', updated_at = ?
         WHERE run_id = ? AND cancel_requested = 0
           AND state IN ('running', 'queued', 'waiting_for_operator')`,
      )
      .run(timestamp, claim.runId);
    host.emit(claim.runId, "node.ready");
  } else if (hasOpenGate) {
    host.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
  } else {
    // Keep running if blocked work may unlock later; otherwise leave state as running
    // until a terminal transition (publish / completed_unpublished / failed).
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, claim.runId);
  }
}

/**
 * Single entry used by scheduler success path and prepared-artifact recovery:
 * CAS commit bytes + attempt/node success, then gate open / unlock / plan accept.
 * Must run inside the owner's outer transaction.
 * Optional metrics are best-effort (Phase 0 observation baseline).
 */
export function commitSuccessfulAttempt(
  host: AttemptSuccessHost,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
  metrics?: AttemptMetrics,
): void {
  const planDelta =
    claim.kind === "plan.adapt" ? validatePlanAdaptation(host, claim, preparations) : undefined;
  const committed = commitNodeArtifacts(host, claim, preparations, metrics);
  if (!committed) return;
  // commitNodeArtifacts already stamped ended_at; reuse now() for run-state updates
  // (same second granularity as before when control flow lived inside commit).
  onAttemptSucceeded(host, claim, preparations, undefined, planDelta);
}

/**
 * After plan Spec is sealed, compile ExecutionPlan (fail-closed on fan-out caps)
 * and prepare it as an unsealed artifact for seal+commit.
 * Called from the scheduler before commitSuccessfulAttempt.
 */
export async function preparePlanExecutionPlan(
  host: ArtifactsHost,
  claim: ClaimedNode,
  preparations: ArtifactPreparation[],
): Promise<ArtifactPreparation | undefined> {
  if (claim.kind !== "plan") return undefined;
  if (preparations.some((p) => p.role === "execution_plan" || p.kind === "execution_plan")) {
    return undefined; // already present
  }
  const specPrep = preparations.find((item) => item.role === "spec" || item.kind === "spec");
  if (!specPrep) throw new Error("plan attempt succeeded without a Spec artifact");

  const runDir = runWorkDir(host.workspace.rootPath, claim.runId);
  const spec = loadSpecJson(path.join(runDir, specPrep.relativePath));
  if (!spec) throw new Error("plan Spec artifact is not parseable");

  // Phase 7: adaptive lenses from inventory + Spec uncertainty (default 1).
  const workspace = host.workspaceForRun(claim.runId);
  const adaptive = resolveAdaptiveOrchestration({
    orchestration: workspace.orchestration,
    inventory: {
      sourceCount: workspace.sources?.length ?? 0,
      multiEntry: (workspace.sources?.length ?? 0) >= 2,
      large: (workspace.sources?.length ?? 0) >= 3,
    },
    planUncertainty: planUncertaintyFromSpec(spec),
  });
  const orch = adaptive.orchestration;
  const plan = compileExecutionPlan(spec, {
    maxDomainFanOut: orch.maxDomainFanOut,
    maxLeafFanOut: orch.maxLeafFanOut,
    reviewCouncilSize: orch.reviewCouncilSize,
    adaptationRequired: !adaptive.lightPath,
    specDigest: specPrep.digest,
  });

  const stageParent = path.join(runDir, "attempts", claim.attemptId, "work");
  await mkdir(stageParent, { recursive: true });
  const planPath = path.join(stageParent, "execution-plan.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  return prepareUnsealedArtifact(host, claim, {
    kind: "execution_plan",
    role: "execution_plan",
    sourcePath: planPath,
    directory: false,
  });
}

/** Load WikiRunSpec JSON from the canonical sealed Spec payload. */
function loadSpecJson(
  artifactRoot: string,
): ReturnType<typeof WikiRunSpecSchema.parse> | undefined {
  try {
    const raw = readFileSync(path.join(artifactRoot, "spec.json"), "utf8");
    return WikiRunSpecSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
