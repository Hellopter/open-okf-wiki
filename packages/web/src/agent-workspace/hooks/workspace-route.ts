/** URL state and invariants for the Agent Workspace route. */

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
