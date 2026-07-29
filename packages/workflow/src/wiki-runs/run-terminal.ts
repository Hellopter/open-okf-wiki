/**
 * Shared run-cancel transitions for CancelRun and plan-gate deny.
 * Keeps abort → cancel_requested → withdraw → effects → attempts → nodes → cancelled ordered.
 *
 * Callers must already be inside the owner's outer BEGIN IMMEDIATE (dispatch / resolve).
 * This helper must not open a nested transaction.
 */

import type { DatabaseSync } from "node:sqlite";
import type { WikiRunEvent } from "@okf-wiki/contract";
import { asRow, requiredNumber } from "./sql.js";

export type TerminalCancelReason = "cancel_requested" | "plan_denied";

export type TerminalCancelHost = {
  db: DatabaseSync;
  emit(runId: string, type: WikiRunEvent["type"]): number;
  abortRunAttempts(runId: string): void;
  withdrawOpenGates(runId: string): void;
  cancelPreApplyEffects(runId: string): void;
};

export type ApplyRunCancelTransitionsInput = {
  runId: string;
  timestamp: string;
  reason: TerminalCancelReason;
  /** Plan deny keeps the resolved gate node generation uncancelled. */
  preserveNode?: { nodeKey: string; generation: number };
  /** CancelRun is idempotent when cancel_requested is already set. */
  skipIfAlreadyRequested?: boolean;
  /**
   * CancelRun CAS: only set cancel_requested while state is still active/cancelling.
   * Plan deny historically updated by run_id alone (gate resolve already gated cancel).
   */
  requireActiveState?: boolean;
};

const ATTEMPT_ERROR: Record<TerminalCancelReason, string> = {
  cancel_requested: "cancel requested",
  plan_denied: "plan denied",
};

const ACTIVE_CANCEL_STATES = "('queued', 'running', 'waiting_for_operator', 'cancelling')";

/**
 * Apply the durable cancel sequence used by CancelRun and plan-gate deny.
 * Returns `{ didMutate: false }` when skipIfAlreadyRequested and cancel was already requested.
 * On mutate, `revision` is the run.cancelled event revision (caller should not re-emit).
 */
export function applyRunCancelTransitions(
  host: TerminalCancelHost,
  input: ApplyRunCancelTransitionsInput,
): { didMutate: false } | { didMutate: true; revision: number } {
  if (input.skipIfAlreadyRequested) {
    const run = asRow(
      host.db.prepare("SELECT cancel_requested FROM runs WHERE run_id = ?").get(input.runId),
    );
    if (run && requiredNumber(run, "cancel_requested") === 1) {
      return { didMutate: false };
    }
  }

  host.abortRunAttempts(input.runId);
  if (input.requireActiveState) {
    host.db
      .prepare(
        `UPDATE runs SET cancel_requested = 1, state = 'cancelling', updated_at = ?
           WHERE run_id = ? AND state IN ${ACTIVE_CANCEL_STATES}`,
      )
      .run(input.timestamp, input.runId);
  } else {
    host.db
      .prepare(
        `UPDATE runs SET cancel_requested = 1, state = 'cancelling', updated_at = ?
           WHERE run_id = ?`,
      )
      .run(input.timestamp, input.runId);
  }
  host.emit(input.runId, "run.cancel_requested");
  host.withdrawOpenGates(input.runId);
  host.cancelPreApplyEffects(input.runId);
  host.db
    .prepare(
      "UPDATE attempts SET state = 'cancelled', error = ?, ended_at = ? WHERE run_id = ? AND state = 'running'",
    )
    .run(ATTEMPT_ERROR[input.reason], input.timestamp, input.runId);

  if (input.preserveNode) {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
           WHERE run_id = ? AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')
             AND NOT (node_key = ? AND generation = ?)`,
      )
      .run(input.runId, input.preserveNode.nodeKey, input.preserveNode.generation);
  } else {
    host.db
      .prepare(
        `UPDATE nodes SET state = 'cancelled', current_attempt_id = NULL
           WHERE run_id = ? AND state IN ('blocked', 'ready', 'running', 'waiting', 'invalidated')`,
      )
      .run(input.runId);
  }

  host.db
    .prepare("UPDATE runs SET state = 'cancelled', updated_at = ? WHERE run_id = ?")
    .run(input.timestamp, input.runId);
  const revision = host.emit(input.runId, "run.cancelled");
  return { didMutate: true, revision };
}
