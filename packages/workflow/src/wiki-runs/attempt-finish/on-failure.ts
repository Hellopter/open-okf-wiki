/**
 * Failure-path control effects after a terminal failed attempt.
 * Policy tree: publication_conflict → research auto-retry → plan sufficiency
 * re-scout → mechanical repair → recovery / fail run (or keep running when
 * siblings have work).
 *
 * publication_conflict branch: stable hook for follow-up #3 — do not rewrite
 * the special-case body without coordinating that change.
 */

import type { PiAttemptFailureClass } from "@okf-wiki/contract/pi-attempt";
import type { WikiRunsControl } from "../ctx.js";
import {
  schedulePlanSufficiencyRescout,
} from "../plan-scout-materialize.js";
import {
  openMechanicalEvaluationRecovery,
  scheduleMechanicalRepair,
  shouldAutoMechanicalRepair,
} from "../repair-schedule.js";
import { asRow, requiredNumber } from "../sql.js";
import {
  type ClaimedNode,
  RESEARCH_AUTO_RETRY_KINDS,
  RESEARCH_AUTO_RETRY_MAX_ATTEMPTS,
} from "../types.js";
import {
  blockNodeAfterPublicationConflict,
  writeFailedAttemptTerminal,
} from "./terminal-rows.js";
import {
  hasActiveNodeWork,
  markRunFailed,
  markRunRunningAfterFailure,
} from "./run-state.js";

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
 * Classes L_control may auto-requeue for research.leaf/domain/plan.scout
 * (same input_digest). Transport after L0 exhaustion maps to infrastructure
 * (or transient when present). capacity / budget / policy / cancel / provider
 * never auto-requeue.
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
 * Limited auto-retry for research.leaf / research.domain / plan.scout only.
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

export function failNode(host: WikiRunsControl, claim: ClaimedNode, error: unknown): void {
  const failureClass = failureClassOf(error);
  const mechanicalReportArtifactId = failureArtifactIdOf(error, "validate_report");
  // Always write the failed attempt/node terminal first (audit). applyRerunAt
  // leaves terminal `failed` generations intact and inserts gen+1 for re-arm.
  const terminal = writeFailedAttemptTerminal(
    host,
    claim,
    error,
    failureClass,
    mechanicalReportArtifactId,
  );
  if (!terminal) return;
  const { timestamp, message } = terminal;

  // ── publication_conflict special case (follow-up #3 hook) ──────────────
  // A publication CAS conflict is an explicit operator decision point, not a
  // failed Run. mechanicalPublish has reopened the payload-bound gate and
  // preserved the candidate; leave publish blocked until that decision.
  if (claim.kind === "publish" && failureClass === "publication_conflict") {
    blockNodeAfterPublicationConflict(host, claim);
    return;
  }

  // Research read-only auto-retry: re-queue same generation with exact input digest.
  if (shouldAutoRetryResearch(host, claim, message, failureClass)) {
    host.requeueFailedNode(claim.runId, claim.nodeKey, claim.nodeGeneration, claim.attemptId);
    host.emit(claim.runId, "node.ready");
    return;
  }

  // Plan coverage / semantic sufficiency re-scout (ADR 0040/0042, WP-C).
  // Prefer typed failureClass coverage_gap|semantic_gap + error.gateFailure.
  // Nested agent re-scout is gone — host re-arms gap plan.scout + reduce + plan
  // while planRescoutMaxRounds remains. On success: emit node.ready and return
  // WITHOUT markRunFailed (run stays queued/running for the re-scout wave).
  if (claim.kind === "plan") {
    if (
      schedulePlanSufficiencyRescout(host, {
        runId: claim.runId,
        planGeneration: claim.nodeGeneration,
        message,
        failureClass,
        error,
      })
    ) {
      host.emit(claim.runId, "node.ready");
      return;
    }
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
  if (!hasActiveNodeWork(host, claim.runId)) {
    const recovery = openMechanicalEvaluationRecovery(
      host,
      claim,
      message,
      failureClass,
      mechanicalReportArtifactId,
    );
    markRunFailed(host, claim.runId, timestamp);
    if (recovery) host.emit(claim.runId, "evaluation.recovery_available");
  } else {
    // Re-evaluate unlock in case other branches can proceed without this node.
    markRunRunningAfterFailure(host, claim.runId, timestamp);
  }
}
