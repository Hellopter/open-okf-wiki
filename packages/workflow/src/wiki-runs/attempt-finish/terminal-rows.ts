/**
 * Attempt/node terminal row writes, metrics, orphan prep, emit.
 * Shared kernels for failure finish and prepared-artifact recovery.
 */

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
