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

/** Minimal message shape for scanning wiki_produce receipts. */
export type MessageForActiveRun = {
  tools?: ReadonlyArray<{
    name: string;
    details?: { runId?: string; status?: string } | null;
  }>;
};

/** Minimal list-item shape for non-terminal Run merge. */
export type RecentRunForActiveRun = {
  runId: string;
  state: WikiRunState;
  updatedAt?: string;
};

/**
 * Resolve the operator-facing active Run id.
 *
 * Authority order:
 * 1. Latest `wiki_produce` receipt (`accepted` + runId), skipping ids that
 *    live snapshot or recentRuns already mark terminal (live wins over list).
 * 2. Weak fallback: newest non-terminal entry in `recentRuns` (UI list only).
 */
export function resolveActiveRunId(input: {
  messages: ReadonlyArray<MessageForActiveRun>;
  recentRuns: ReadonlyArray<RecentRunForActiveRun>;
  /**
   * Live shell projection for the currently subscribed run — stronger than
   * `recentRuns` when deciding whether an accepted receipt is still active.
   */
  liveRun?: { runId: string; state: WikiRunState } | null;
}): string | null {
  const byId = new Map(input.recentRuns.map((run) => [run.runId, run]));
  const live = input.liveRun ?? null;

  const isKnownTerminal = (runId: string): boolean => {
    if (live?.runId === runId && !isNonTerminalWikiRunState(live.state)) {
      return true;
    }
    const known = byId.get(runId);
    return Boolean(known && !isNonTerminalWikiRunState(known.state));
  };

  const acceptedIds: string[] = [];
  for (const message of input.messages) {
    for (const tool of message.tools ?? []) {
      if (tool.name !== "wiki_produce") continue;
      const details = tool.details;
      if (!details || details.status !== "accepted") continue;
      const runId = typeof details.runId === "string" ? details.runId.trim() : "";
      if (runId) acceptedIds.push(runId);
    }
  }

  for (let i = acceptedIds.length - 1; i >= 0; i--) {
    const runId = acceptedIds[i]!;
    if (!isKnownTerminal(runId)) {
      return runId;
    }
  }

  const nonTerminal = input.recentRuns
    .filter((run) => {
      if (live?.runId === run.runId && !isNonTerminalWikiRunState(live.state)) {
        return false;
      }
      return isNonTerminalWikiRunState(run.state);
    })
    .slice()
    .sort((a, b) => {
      const at = a.updatedAt ?? "";
      const bt = b.updatedAt ?? "";
      if (at !== bt) return bt.localeCompare(at);
      return b.runId.localeCompare(a.runId);
    });

  return nonTerminal[0]?.runId ?? null;
}
