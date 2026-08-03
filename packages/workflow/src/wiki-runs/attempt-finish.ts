/**
 * Single post-attempt finish hub after a sealed/terminal attempt.
 *
 * Ordered control effects:
 * 1. CAS / terminal attempt+node rows (success: commitNodeArtifacts; failure: fail rows)
 * 2. Success: gates / unlock / EvaluationRound re-arm / run-state
 * 3. Failure: research auto-retry / scheduleMechanicalRepair / recovery / fail run
 *
 * Scheduler claims + executes, then calls commitSuccessfulAttempt / failNode here.
 * Gate open / repair schedule policy lives here — not in the scheduler loop.
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiAttemptFailureClass } from "@okf-wiki/contract/pi-attempt";
import type { AttemptMetrics } from "@okf-wiki/contract/wiki-runs";
import {
  planUncertaintyFromSpec,
  resolveAdaptiveOrchestration,
  WikiRunSpecSchema,
} from "@okf-wiki/contract/wiki-runs";
import { runWorkDir, toAdaptiveRepositoryInventory } from "@okf-wiki/core";
import { compileExecutionPlan } from "../plan-compiler.js";
import {
  commitNodeArtifacts,
  loadSealedDefectsReport,
  prepareUnsealedArtifact,
  verifyArtifact,
} from "./artifacts.js";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  metricsOf,
  wallTimeMsFromStarted,
  writeAttemptMetrics,
} from "./attempt-metrics.js";
import {
  assertCoverageForSealedSpec,
  loadSealedContractCoveragePlan,
  loadSealedCoverageInventory,
} from "./coverage-bridge.js";
import { digest, now } from "./crypto-util.js";
import type { WikiRunsCasCtx, WikiRunsControl } from "./ctx.js";
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
import { materializePlanAdaptation, validatePlanAdaptation } from "./plan-adapt.js";
import { planGateDetailFromSpec, planGatePayloadDigest } from "./plan-review.js";
import {
  isRepairNodeKey,
  loadAcceptance,
  openMechanicalEvaluationRecovery,
  rearmEvaluationRoundAfterRepair,
  scheduleAutomaticSemanticRepair,
  scheduleMechanicalRepair,
  shouldAutoMechanicalRepair,
} from "./repair-schedule.js";
import { asRow, asRows, requiredNumber, requiredText, type SqlRow } from "./sql.js";
import {
  type ArtifactPreparation,
  type ClaimedFreeze,
  type ClaimedNode,
  RESEARCH_AUTO_RETRY_KINDS,
  RESEARCH_AUTO_RETRY_MAX_ATTEMPTS,
} from "./types.js";

function freezeCommitHost(host: WikiRunsControl): FreezeCommitHost {
  return {
    db: host.db,
    isCurrent: (claim) => host.isCurrent(claim),
    emit: (runId, type) => host.emit(runId, type),
  };
}

function orphanPreparedGroup(host: WikiRunsControl, attemptId: string): void {
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
export async function recoverPreparedArtifacts(host: WikiRunsControl): Promise<void> {
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
  host: WikiRunsControl,
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
    const workspace = host.workspaceForRun(claim.runId);
    const runDir = runWorkDir(workspace.rootPath, claim.runId);
    let sealedSpec: ReturnType<typeof WikiRunSpecSchema.parse> | undefined;
    try {
      const raw = readFileSync(path.join(runDir, specPrep.relativePath, "spec.json"), "utf8");
      sealedSpec = WikiRunSpecSchema.parse(JSON.parse(raw));
    } catch {
      sealedSpec = undefined;
    }
    // planConfirm=false: auto-approve — same onPlanAccepted path as ResolveGate approve.
    // ADR 0040: assertCoverage on this path (UI disable alone is insufficient).
    if (workspace.planConfirm === false) {
      assertCoverageForSealedSpec(host.db, claim.runId, runDir, sealedSpec, {
        requireSpec: true,
      });
      onPlanAccepted(host, claim.runId, specPrep.relativePath, timestamp);
      return;
    }
    let planDetail: ReturnType<typeof planGateDetailFromSpec> | undefined;
    if (sealedSpec) {
      planDetail = planGateDetailFromSpec(sealedSpec);
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
      scheduleAutomaticSemanticRepair(host, claim, timestamp)
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
    isRepairNodeKey(claim.nodeKey) ||
    (claim.kind === "repair" && claim.nodeKey.startsWith("repair."))
  ) {
    rearmEvaluationRoundAfterRepair(host, claim.runId);
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
  host: WikiRunsControl,
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
 * After plan Spec is sealed, compile ExecutionPlan (fail-closed on fan-out caps
 * and coverage gaps when a CoveragePlan is sealed) and prepare it as an unsealed
 * artifact for seal+commit.
 * Called from the scheduler before commitSuccessfulAttempt.
 */
export async function preparePlanExecutionPlan(
  host: WikiRunsCasCtx,
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
  const sealedInventory = loadSealedCoverageInventory(host.db, claim.runId, runDir);
  // multiEntry is an inventory walk signal (multi-package monorepo) — never
  // implied by multi-source alone (sourceCount). Without sealed inventory we
  // only know sourceCount; omit multiEntry/large so adaptive-router treats them false.
  const inventory = sealedInventory
    ? toAdaptiveRepositoryInventory(sealedInventory)
    : {
        sourceCount: workspace.sources?.length ?? 0,
      };
  const adaptive = resolveAdaptiveOrchestration({
    orchestration: workspace.orchestration,
    inventory,
    planUncertainty: planUncertaintyFromSpec(spec),
  });
  const orch = adaptive.orchestration;
  const coveragePlan = loadSealedContractCoveragePlan(host.db, claim.runId, runDir);
  const plan = compileExecutionPlan(spec, {
    maxDomainFanOut: orch.maxDomainFanOut,
    maxLeafFanOut: orch.maxLeafFanOut,
    reviewCouncilSize: orch.reviewCouncilSize,
    adaptationRequired: !adaptive.lightPath,
    specDigest: specPrep.digest,
    ...(coveragePlan ? { coveragePlan } : {}),
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

// ─── Failure path ─────────────────────────────────────────────────────────

/** Extract typed failureClass from a failed outcome Error or plain object. */
export function failureClassOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "failureClass" in error) {
    const value = (error as { failureClass?: unknown }).failureClass;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}

function failureArtifactIdOf(error: unknown, role: string): string | undefined {
  if (!error || typeof error !== "object" || !("failureArtifacts" in error)) return undefined;
  const artifacts = (error as { failureArtifacts?: unknown }).failureArtifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return undefined;
  const artifactId = (artifacts as Record<string, unknown>)[role];
  return typeof artifactId === "string" && artifactId.trim() ? artifactId : undefined;
}

/**
 * Classes L_control may auto-requeue for research.leaf/domain (same input_digest).
 * Transport after L0 exhaustion maps to infrastructure (or transient when present).
 * capacity / budget / policy / cancel / provider never auto-requeue.
 */
const RESEARCH_AUTO_RETRY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "transient",
  "infrastructure",
]);

/** Typed classes that must never auto-requeue (even if message looks flaky). */
const RESEARCH_NO_AUTO_RETRY_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  "capacity",
  "budget",
  "policy",
  "cancelled",
  "cancel",
  "provider",
]);

export function failNode(host: WikiRunsControl, claim: ClaimedNode, error: unknown): void {
  if (!host.isCurrent(claim)) return;
  const timestamp = now();
  const message =
    error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
  const failureClass = failureClassOf(error);
  const mechanicalReportArtifactId = failureArtifactIdOf(error, "validate_report");
  host.db
    .prepare(
      `UPDATE attempts SET state = 'failed', error = ?, failure_class = ?, ended_at = ?
       WHERE attempt_id = ? AND state = 'running'`,
    )
    .run(message, failureClass ?? null, timestamp, claim.attemptId);
  const resolved = mergeAttemptMetrics(metricsOf(error), {
    role: graphRoleForNodeKind(claim.kind),
    wallTimeMs: wallTimeMsFromStarted(host.db, claim.attemptId, timestamp),
    stopReason: failureClass ?? "failed",
  });
  writeAttemptMetrics(host.db, claim.attemptId, resolved);
  host.db
    .prepare(
      `UPDATE nodes SET state = 'failed', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ? AND current_attempt_id = ?`,
    )
    .run(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(claim.attemptId);
  host.emit(claim.runId, "attempt.failed");

  // A publication CAS conflict is an explicit operator decision point, not a
  // failed Run. mechanicalPublish has reopened the payload-bound gate and
  // preserved the candidate; leave publish blocked until that decision.
  if (claim.kind === "publish" && failureClass === "publication_conflict") {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
         WHERE run_id = ? AND node_key = ? AND generation = ?`,
      )
      .run(claim.runId, claim.nodeKey, claim.nodeGeneration);
    return;
  }

  // Research read-only auto-retry: re-queue same generation with exact input digest.
  if (shouldAutoRetryResearch(host, claim, message, failureClass)) {
    host.requeueFailedNode(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    host.emit(claim.runId, "node.ready");
    return;
  }

  // Mechanical model repair: schedule a dedicated repair.N stage with
  // validation feedback under EvaluationPolicy.mechanical.modelRepairBudget
  // (default 0; host autofix preferred). Independent of research L_control and council.
  // Does NOT disguise fix as write.root (write stays at its successful generation).
  if (shouldAutoMechanicalRepair(host, claim, message, failureClass)) {
    if (scheduleMechanicalRepair(host, claim, message, mechanicalReportArtifactId)) {
      host.emit(claim.runId, "node.ready");
      return;
    }
  }

  // Siblings may still be ready/running, or an open gate may be waiting.
  // Do not count 'blocked' alone as progress — a failed critical-path node leaves
  // downstream blocked forever; without ready/running/waiting work the run is failed.
  const hasWork = asRow(
    host.db
      .prepare(
        `SELECT 1 AS present FROM nodes
         WHERE run_id = ? AND state IN ('ready', 'running', 'waiting')
           AND generation = (
             SELECT MAX(n2.generation) FROM nodes n2
             WHERE n2.run_id = nodes.run_id AND n2.node_key = nodes.node_key
           )
         LIMIT 1`,
      )
      .get(claim.runId),
  );
  if (!hasWork) {
    const recovery = openMechanicalEvaluationRecovery(
      host,
      claim,
      message,
      failureClass,
      mechanicalReportArtifactId,
    );
    host.db
      .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
      .run(timestamp, claim.runId);
    if (recovery) host.emit(claim.runId, "evaluation.recovery_available");
  } else {
    // Re-evaluate unlock in case other branches can proceed without this node.
    unlockReadyNodes(host, claim.runId);
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0 AND state NOT IN ('waiting_for_operator', 'cancelling', 'cancelled')",
      )
      .run(timestamp, claim.runId);
  }
}

/**
 * Clear transport / infrastructure message patterns used only when failureClass
 * is missing (legacy bare Errors). Product defects must not match.
 */
const RESEARCH_AUTO_RETRY_MESSAGE_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /\b(?:429|500|502|503|529)\b/,
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bEPIPE\b/,
  /socket hang up/i,
  /fetch failed/i,
  /network error/i,
  /\boverloaded\b/i,
  /service unavailable/i,
  /bad gateway/i,
  /internal server error/i,
  /connection (?:closed|reset|refused|error)/i,
  /\binfrastructure\b/i,
  /\btransient\b/i,
];

/**
 * Limited auto-retry for research.leaf / research.domain only.
 * Budget: RESEARCH_AUTO_RETRY_MAX_ATTEMPTS total Attempts per generation.
 * Prefer typed failureClass; missing class is fail-closed unless the message
 * clearly matches transport/infrastructure patterns (never bare product errors
 * like "requires sealed sources").
 * Allow: transient, infrastructure. Deny: capacity, budget, policy, cancel, provider.
 */
export function shouldAutoRetryResearch(
  host: WikiRunsControl,
  claim: ClaimedNode,
  message: string,
  failureClass?: string | PiAttemptFailureClass,
): boolean {
  if (!RESEARCH_AUTO_RETRY_KINDS.has(claim.kind)) return false;
  // Align with workspace.limits.retry.enabled — off means no control-plane auto-requeue.
  if (host.workspaceForRun(claim.runId).limits.retry.enabled === false) return false;
  if (host.closed) return false;
  const run = asRow(
    host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(claim.runId),
  );
  if (!run || requiredNumber(run, "cancel_requested") === 1) return false;

  const cls = failureClass?.trim().toLowerCase();
  if (cls) {
    if (RESEARCH_NO_AUTO_RETRY_FAILURE_CLASSES.has(cls)) return false;
    if (!RESEARCH_AUTO_RETRY_FAILURE_CLASSES.has(cls)) return false;
  } else {
    // Fail-closed when failureClass was not plumbed: only clear transport/infra
    // messages may requeue. Bare product errors never auto-requeue.
    if (!RESEARCH_AUTO_RETRY_MESSAGE_PATTERNS.some((p) => p.test(message))) {
      return false;
    }
  }

  const countRow = asRow(
    host.db
      .prepare(
        `SELECT COUNT(*) AS count FROM attempts
         WHERE run_id = ? AND node_key = ? AND node_generation = ?
           AND state IN ('failed', 'interrupted', 'cancelled')`,
      )
      .get(claim.runId, claim.nodeKey, claim.nodeGeneration),
  );
  const failedCount = requiredNumber(countRow ?? { count: 0 }, "count");
  // failedCount includes this just-failed Attempt; allow one more total Attempt.
  return failedCount < RESEARCH_AUTO_RETRY_MAX_ATTEMPTS;
}
