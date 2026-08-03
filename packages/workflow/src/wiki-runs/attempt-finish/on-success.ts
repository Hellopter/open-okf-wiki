/**
 * Success-path control effects after CAS seal of a successful attempt.
 * Kind dispatch: plan / prepare.publication / review.reduce / publish / plan.adapt / repair re-arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { AttemptMetrics } from "@okf-wiki/contract/wiki-runs";
import { WikiRunSpecSchema } from "@okf-wiki/contract/wiki-runs";
import { runWorkDir } from "@okf-wiki/core";
import { commitNodeArtifacts, loadSealedDefectsReport } from "../artifacts.js";
import { assertCoverageForSealedSpec } from "../coverage-bridge.js";
import { digest, now } from "../crypto-util.js";
import type { WikiRunsControl } from "../ctx.js";
import {
  autoPassFixGate,
  openFixGate,
  openPlanGate,
  openPublicationGate,
  readPublicationBaseline,
} from "../gate-open.js";
import { onPlanAccepted } from "../gate-resolve.js";
import { materializePlanAdaptation, validatePlanAdaptation } from "../plan-adapt.js";
import { planGateDetailFromSpec, planGatePayloadDigest } from "../plan-review.js";
import {
  isRepairNodeKey,
  loadAcceptance,
  rearmEvaluationRoundAfterRepair,
  scheduleAutomaticSemanticRepair,
} from "../repair-schedule.js";
import type { ArtifactPreparation, ClaimedNode } from "../types.js";
import { markRunPublished, recomputeRunState } from "./run-state.js";

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
    markRunPublished(host, claim.runId, timestamp);
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

  recomputeRunState(host, claim.runId, timestamp);
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
