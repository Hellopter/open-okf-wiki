/**
 * Run-state recompute after attempt finish (success unlock / failure hasWork).
 * Success and failure policy trees stay separate — shared SQL kernels only.
 */

import type { WikiRunsControl } from "../ctx.js";
import { unlockReadyNodes } from "../dag.js";
import { asRow } from "../sql.js";

/** Latest-generation nodes in ready state. */
export function hasReadyNodes(host: Pick<WikiRunsControl, "db">, runId: string): boolean {
  return Boolean(
    asRow(
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
        .get(runId),
    ),
  );
}

/** Open HITL gates (gates table — not stale gate.* waiting nodes). */
export function hasOpenGate(host: Pick<WikiRunsControl, "db">, runId: string): boolean {
  return Boolean(
    asRow(
      host.db
        .prepare(`SELECT 1 AS present FROM gates WHERE run_id = ? AND state = 'open' LIMIT 1`)
        .get(runId),
    ),
  );
}

/**
 * Latest-generation nodes still in ready/running/waiting.
 * Failure path: without this the run is terminal-failed (or recovery-available).
 */
export function hasActiveNodeWork(host: Pick<WikiRunsControl, "db">, runId: string): boolean {
  return Boolean(
    asRow(
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
        .get(runId),
    ),
  );
}

/**
 * After success control effects (gates / unlock / re-arm): derive run state from
 * ready work vs open gates. Ready wins over stale waiting_for_operator.
 */
export function recomputeRunState(
  host: WikiRunsControl,
  runId: string,
  timestamp: string,
): void {
  unlockReadyNodes(host, runId);
  if (hasReadyNodes(host, runId)) {
    // Ready work wins over a stale waiting_for_operator (e.g. withdrawn pub gate
    // node still marked waiting while review.reduce is ready).
    host.db
      .prepare(
        `UPDATE runs SET state = 'queued', updated_at = ?
         WHERE run_id = ? AND cancel_requested = 0
           AND state IN ('running', 'queued', 'waiting_for_operator')`,
      )
      .run(timestamp, runId);
    host.emit(runId, "node.ready");
  } else if (hasOpenGate(host, runId)) {
    host.db
      .prepare(
        "UPDATE runs SET state = 'waiting_for_operator', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, runId);
  } else {
    // Keep running if blocked work may unlock later; otherwise leave state as running
    // until a terminal transition (publish / completed_unpublished / failed).
    host.db
      .prepare(
        "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
      )
      .run(timestamp, runId);
  }
}

/** Success path: publish node sealed → run published. */
export function markRunPublished(
  host: WikiRunsControl,
  runId: string,
  timestamp: string,
): void {
  host.db
    .prepare(
      "UPDATE runs SET state = 'published', updated_at = ? WHERE run_id = ? AND cancel_requested = 0",
    )
    .run(timestamp, runId);
  host.emit(runId, "run.published");
}

/** Failure path: no remaining ready/running/waiting work → run failed. */
export function markRunFailed(
  host: Pick<WikiRunsControl, "db">,
  runId: string,
  timestamp: string,
): void {
  host.db
    .prepare("UPDATE runs SET state = 'failed', updated_at = ? WHERE run_id = ?")
    .run(timestamp, runId);
}

/**
 * Failure path when siblings may still progress: re-unlock and keep running
 * (do not clobber waiting_for_operator / cancelling / cancelled).
 */
export function markRunRunningAfterFailure(
  host: WikiRunsControl,
  runId: string,
  timestamp: string,
): void {
  unlockReadyNodes(host, runId);
  host.db
    .prepare(
      "UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ? AND cancel_requested = 0 AND state NOT IN ('waiting_for_operator', 'cancelling', 'cancelled')",
    )
    .run(timestamp, runId);
}
