/** URL state and invariants for the Agent Workspace route. */

import type { WikiRunState } from "@okf-wiki/contract";
import { isTerminalWikiRunState } from "../components/run-actions.ts";

export type AgentWorkspaceRouteState = {
  sessionId: string | null;
  runId: string | null;
  attemptId: string | null;
};

export function readAgentWorkspaceRoute(search: URLSearchParams): AgentWorkspaceRouteState {
  return {
    sessionId: search.get("sessionId"),
    runId: search.get("run"),
    attemptId: search.get("attempt"),
  };
}

function nextSearch(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete("rootPath");
  return next;
}

export function selectAgentWorkspaceSession(
  search: URLSearchParams,
  sessionId: string,
): URLSearchParams {
  const next = nextSearch(search);
  next.set("sessionId", sessionId);
  return next;
}

export function selectAgentWorkspaceRun(search: URLSearchParams, runId: string): URLSearchParams {
  const next = nextSearch(search);
  next.set("run", runId);
  next.delete("attempt");
  return next;
}

export function focusAgentWorkspaceRun(
  search: URLSearchParams,
  runId: string,
  attemptId?: string | null,
): URLSearchParams {
  const next = nextSearch(search);
  next.set("run", runId);
  if (attemptId) next.set("attempt", attemptId);
  else next.delete("attempt");
  return next;
}

/** Drop Run / Attempt selection (e.g. Session has no linked WikiRuns). */
export function clearAgentWorkspaceRun(search: URLSearchParams): URLSearchParams {
  const next = nextSearch(search);
  next.delete("run");
  next.delete("attempt");
  return next;
}

export function selectAgentWorkspaceAttempt(
  search: URLSearchParams,
  attemptId: string | null,
): URLSearchParams {
  const next = nextSearch(search);
  if (attemptId) next.set("attempt", attemptId);
  else next.delete("attempt");
  return next;
}

export type ReceiptReconciliation = {
  seenRunId: string | null;
  focusRunId: string | null;
};

/** The first ready Session snapshot establishes history; only later receipts focus a Run. */
export function reconcileAcceptedReceipt(
  seenRunId: string | null | undefined,
  latestRunId: string | null,
): ReceiptReconciliation {
  if (seenRunId === undefined) {
    return { seenRunId: latestRunId, focusRunId: null };
  }
  if (!latestRunId || latestRunId === seenRunId) {
    return { seenRunId, focusRunId: null };
  }
  return { seenRunId: latestRunId, focusRunId: latestRunId };
}

/** Slim run row needed to rebind `?run=` to a Session (ADR 0026 I5/I6). */
export type SessionLinkedRunCandidate = {
  runId: string;
  state: WikiRunState | string;
  sessionId?: string | null;
};

export type PickRunForSessionOptions = {
  /**
   * Prefer this run when it still exists (boot deep-link / already focused).
   * When `allowPreferredOutsideSession` is false (Session switch), only keep it
   * if it is linked to the target Session.
   */
  preferredRunId?: string | null;
  /** Boot: honor workspace-wide `?run=` even if started from another Session. */
  allowPreferredOutsideSession?: boolean;
};

/**
 * Resolve the WikiRun to show for one Operator Session.
 *
 * Control-plane truth is `operator_session_id` on WikiRuns list rows — not
 * message-derived activeRunId (ADR 0036). Prefer a non-terminal linked run,
 * else the newest linked run. Returns null when the Session has no link.
 */
export function pickRunForSession(
  runs: readonly SessionLinkedRunCandidate[],
  sessionId: string | null | undefined,
  options: PickRunForSessionOptions = {},
): string | null {
  const preferred = options.preferredRunId?.trim() || null;
  const sid = sessionId?.trim() || null;
  const linked = sid ? runs.filter((run) => run.sessionId === sid) : [];

  if (preferred) {
    const row = runs.find((run) => run.runId === preferred);
    if (row) {
      const belongs = sid !== null && row.sessionId === sid;
      if (belongs || options.allowPreferredOutsideSession === true || !sid) {
        return preferred;
      }
    }
  }

  if (linked.length === 0) return null;
  const live = linked.find((run) => !isTerminalWikiRunState(run.state as WikiRunState));
  return live?.runId ?? linked[0]?.runId ?? null;
}

/** Runs shown in the Session-scoped picker (linked + currently selected). */
export function filterRunsForSession<T extends SessionLinkedRunCandidate>(
  runs: readonly T[],
  sessionId: string | null | undefined,
  selectedRunId?: string | null,
): T[] {
  const sid = sessionId?.trim() || null;
  if (!sid) return [...runs];
  return runs.filter(
    (run) => run.sessionId === sid || (selectedRunId != null && run.runId === selectedRunId),
  );
}
