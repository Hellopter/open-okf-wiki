/**
 * Attempt/node terminal row writes, metrics, orphan prep, emit.
 * Shared kernels for failure finish and prepared-artifact recovery.
 */

import type { AttemptMetrics } from "@okf-wiki/contract/wiki-runs";
import type { GateFailure } from "@okf-wiki/contract/pi-attempt";
import {
  graphRoleForNodeKind,
  mergeAttemptMetrics,
  metricsOf,
  wallTimeMsFromStarted,
  writeAttemptMetrics,
} from "../attempt-metrics.js";
import { now } from "../crypto-util.js";
import type { WikiRunsControl } from "../ctx.js";
import type { ClaimedNode } from "../types.js";

/** Orphan all prepared artifacts for an attempt (transactional — recovery path). */
export function orphanPreparedGroup(host: WikiRunsControl, attemptId: string): void {
  host.transaction(() =>
    host.db
      .prepare(
        "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
      )
      .run(attemptId),
  );
}

/** Orphan prepared artifacts for an attempt (same outer transaction as fail path). */
export function orphanPreparedForAttempt(
  host: Pick<WikiRunsControl, "db">,
  attemptId: string,
): void {
  host.db
    .prepare(
      "UPDATE artifact_preparations SET state = 'orphaned' WHERE attempt_id = ? AND state = 'prepared'",
    )
    .run(attemptId);
}

export type FailedAttemptTerminal = {
  timestamp: string;
  message: string;
  failureClass: string | undefined;
  mechanicalReportArtifactId: string | undefined;
};

/**
 * Pull structured gateFailure off a failed outcome Error / plain object so it
 * can be durable on attempts.metrics_json for operator RetryFailedNode (WP-D).
 */
export function gateFailureOf(error: unknown): GateFailure | undefined {
  if (!error || typeof error !== "object" || !("gateFailure" in error)) return undefined;
  const raw = (error as { gateFailure?: unknown }).gateFailure;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const gf = raw as GateFailure;
  if (
    gf.kind !== "coverage" &&
    gf.kind !== "semantic_sufficiency" &&
    gf.kind !== "spec_fanout" &&
    gf.kind !== "other"
  ) {
    return undefined;
  }
  return gf;
}

/**
 * Merge executor metrics with durable gateFailure in metrics.extra so operator
 * retry can re-arm plan sufficiency without re-parsing free-form error strings.
 */
export function metricsWithGateFailure(
  error: unknown,
  base: AttemptMetrics | undefined = metricsOf(error),
): AttemptMetrics | undefined {
  const gf = gateFailureOf(error);
  if (!gf) return base;
  // Compact durable shape — gaps preferred; full result optional and bounded.
  const durable: Record<string, unknown> = { kind: gf.kind };
  if (gf.code) durable.code = gf.code;
  if (Array.isArray(gf.gaps) && gf.gaps.length > 0) {
    durable.gaps = gf.gaps
      .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
      .map((g) => g.trim())
      .slice(0, 64);
  }
  return {
    ...(base ?? {}),
    extra: {
      ...(base?.extra ?? {}),
      gateFailure: durable,
    },
  };
}

/**
 * CAS-guarded failure terminal rows: attempt failed, metrics, node failed,
 * orphan prepared artifacts, emit attempt.failed.
 * Returns null when the claim is no longer current.
 */
export function writeFailedAttemptTerminal(
  host: WikiRunsControl,
  claim: ClaimedNode,
  error: unknown,
  failureClass: string | undefined,
  mechanicalReportArtifactId: string | undefined,
): FailedAttemptTerminal | null {
  if (!host.isCurrent(claim)) return null;
  const timestamp = now();
  const message =
    error instanceof Error ? error.message.slice(0, 4_000) : `${claim.nodeKey} failed`;
  host.db
    .prepare(
      `UPDATE attempts SET state = 'failed', error = ?, failure_class = ?, ended_at = ?
       WHERE attempt_id = ? AND state = 'running'`,
    )
    .run(message, failureClass ?? null, timestamp, claim.attemptId);
  // Persist gateFailure on metrics_json so RetryFailedNode can re-arm scouts
  // from the same structured gaps as the automatic failNode path (WP-D).
  const resolved = mergeAttemptMetrics(metricsWithGateFailure(error), {
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
  orphanPreparedForAttempt(host, claim.attemptId);
  host.emit(claim.runId, "attempt.failed");
  return { timestamp, message, failureClass, mechanicalReportArtifactId };
}

/**
 * publication_conflict: flip the just-failed publish node to blocked so the
 * reopened payload-bound gate remains the operator decision point.
 * Hook for follow-up #3 — keep this body stable when extending fail policy.
 */
export function blockNodeAfterPublicationConflict(
  host: Pick<WikiRunsControl, "db">,
  claim: ClaimedNode,
): void {
  host.db
    .prepare(
      `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
       WHERE run_id = ? AND node_key = ? AND generation = ?`,
    )
    .run(claim.runId, claim.nodeKey, claim.nodeGeneration);
}
