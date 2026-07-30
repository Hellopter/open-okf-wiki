/**
 * Dual-surface operator chrome: Session turn vs durable WikiRun (ADR 0035).
 *
 * After wiki_produce returns accepted+runId, the Session may go idle while the
 * Run continues. Send/Stop-session track only Session; Stop-run tracks Run.
 */

import type { WikiRunState } from "@okf-wiki/contract";

/** Run states that no longer need operator chrome for an active Run. */
export const TERMINAL_WIKI_RUN_STATES: ReadonlySet<WikiRunState> = new Set([
  "published",
  "cancelled",
  "failed",
  "completed_unpublished",
  "publication_declined",
]);

/** Run states where cancel_run is meaningful (in-flight / cancel in progress). */
const BUSY_WIKI_RUN_STATES: ReadonlySet<WikiRunState> = new Set([
  "queued",
  "running",
  "cancelling",
]);

export type ActiveRunChrome = {
  runId: string;
  state: WikiRunState;
  openGateKinds?: string[];
  hasRunningAttempt?: boolean;
};

export type OperatorChrome = {
  /** Session is mid-turn (sending or streaming). */
  sessionPending: boolean;
  /** Durable Run is queued, running, or cancelling. */
  runBusy: boolean;
  /** Durable Run is blocked on an operator gate. */
  runNeedsOperator: boolean;
  /** Show Session abort (agent-abort). */
  showStopSession: boolean;
  /** Show Run cancel (agent-stop-run). */
  showStopRun: boolean;
  /**
   * Disable Send only for Session pending — chat stays available while a Run
   * is busy so the operator can ask questions or steer.
   */
  sendDisabled: boolean;
  /** Optional raw WikiRun state for status chip / tests. */
  runStatusLabel?: string;
};

export type SessionStatusForChrome = "idle" | "sending" | "streaming" | "error";

export function isNonTerminalWikiRunState(state: WikiRunState): boolean {
  return !TERMINAL_WIKI_RUN_STATES.has(state);
}

/**
 * Derive dual-surface chrome from Session status + optional active Run.
 *
 * Rules:
 * - sessionPending = sending | streaming (error does not count)
 * - runBusy = queued | running | cancelling
 * - runNeedsOperator = waiting_for_operator
 * - showStopSession = sessionPending
 * - showStopRun = runBusy
 * - sendDisabled = sessionPending only (Send stays enabled on error for retry)
 */
export function deriveOperatorChrome(input: {
  sessionStatus: SessionStatusForChrome;
  activeRun: ActiveRunChrome | null;
}): OperatorChrome {
  const sessionPending =
    input.sessionStatus === "sending" || input.sessionStatus === "streaming";
  const state = input.activeRun?.state;
  const runBusy = state !== undefined && BUSY_WIKI_RUN_STATES.has(state);
  const runNeedsOperator = state === "waiting_for_operator";

  return {
    sessionPending,
    runBusy,
    runNeedsOperator,
    showStopSession: sessionPending,
    showStopRun: runBusy,
    sendDisabled: sessionPending,
    runStatusLabel: state,
  };
}

// Phase 6 hard-cut: active Run id is URL `?run=` only.
// Message-derived resolveActiveRunId was deleted — receipts only update the URL.
