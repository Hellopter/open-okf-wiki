/** Create, delete, list, and load Pi-native Operator Sessions. */

import {
  createOperatorSession,
  deleteOperatorSession,
  loadOperatorSessionHistory,
  type OperatorSessionHistory,
  redactSensitiveValue,
} from "@okf-wiki/agent";
import type { SessionUsage, WorkspaceConfig } from "@okf-wiki/contract";
import {
  createLiveSessionFlight,
  deleteLiveSessionFlight,
  getLiveSession,
  isDeletingLiveSession,
  listLiveAgentSessionSummaries,
  registerLive,
  sweepIdleLiveSessions,
  unregisterLiveSession,
  waitForOpeningLiveSession,
} from "./live-session-registry.ts";
import { runtimeInput } from "./runtime-input.ts";
import { defaultTitle, type LiveAgentSessionSummary } from "./session-runtime.ts";
import { composeSessionUsage } from "./session-usage.ts";

const DELETE_SETTLE_TIMEOUT_MS = 5_000;

export type { LiveAgentSessionSummary } from "./session-runtime.ts";

async function createLiveRuntime(input: {
  workspace: WorkspaceConfig;
  sessionId?: string;
  title?: string;
}): Promise<ReturnType<typeof registerLive>> {
  const runtime = await runtimeInput(input.workspace, input.sessionId);
  if (input.sessionId && isDeletingLiveSession(input.workspace.id, input.sessionId)) {
    throw new Error(`Operator Session is being deleted: ${input.sessionId}`);
  }
  const handle = await createOperatorSession({
    ...runtime.input,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  if (isDeletingLiveSession(input.workspace.id, handle.sessionId)) {
    try {
      handle.dispose();
    } catch {
      // Already disposed.
    }
    throw new Error(`Operator Session is being deleted: ${handle.sessionId}`);
  }
  handle.session.setSessionName(input.title?.trim() || defaultTitle(input.workspace));
  return registerLive(input.workspace, handle, runtime.queueFixtureTurn);
}

/** Create a Pi SessionManager session and retain its long-lived runtime. */
export async function registerAgentSession(input: {
  workspace: WorkspaceConfig;
  sessionId?: string;
  title?: string;
}): Promise<LiveAgentSessionSummary> {
  const requestedId = input.sessionId?.trim();
  const runtime = requestedId
    ? await createLiveSessionFlight(input.workspace.id, requestedId, () =>
        createLiveRuntime({ ...input, sessionId: requestedId }),
      )
    : await createLiveRuntime(input);
  return runtime.summary();
}

/**
 * Abort a live turn, wait briefly for Pi idle/admission settlement, dispose its
 * runtime, then delete only the SessionManager JSONL. WikiRuns are untouched.
 */
export async function deleteAgentSession(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<{ sessionId: string; removed: number }> {
  return deleteLiveSessionFlight(workspace.id, sessionId, async () => {
    await waitForOpeningLiveSession(workspace.id, sessionId);
    const runtime = getLiveSession(workspace.id, sessionId);
    const hadLive = Boolean(runtime);

    if (runtime) {
      runtime.beginClosing();
      await runtime.abortAndSettle(DELETE_SETTLE_TIMEOUT_MS);
      runtime.dispose();
      unregisterLiveSession(runtime);
    }

    const result = await deleteOperatorSession(workspace.rootPath, sessionId);
    return {
      sessionId,
      removed: hadLive || result.deleted ? 1 : 0,
    };
  });
}

export type AgentSessionHistoryLoad = OperatorSessionHistory & {
  sessionUsage?: SessionUsage;
};

/** Read full durable branch history, preferring the retained live runtime. */
export async function loadAgentSessionHistory(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<AgentSessionHistoryLoad | null> {
  sweepIdleLiveSessions();
  const runtime = getLiveSession(workspace.id, sessionId);
  if (runtime) return runtime.history();

  const history = await loadOperatorSessionHistory(workspace.rootPath, sessionId);
  if (!history) return null;
  const sessionUsage = composeSessionUsage({
    contextTokens: history.lastContextTokens,
    workspace,
  });
  return {
    sessionId: history.sessionId,
    messages: redactSensitiveValue(history.messages),
    ...(sessionUsage ? { sessionUsage } : {}),
  };
}

export { listLiveAgentSessionSummaries };
