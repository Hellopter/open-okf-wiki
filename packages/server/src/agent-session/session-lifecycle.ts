/**
 * Create / delete / list Operator Sessions.
 */

import {
  createOperatorSession,
  deleteOperatorSession,
  loadOperatorSessionHistory,
  type OperatorSessionHistory,
  projectOperatorAgentMessages,
  projectOperatorHistoryFromManager,
  redactSensitiveValue,
} from "@okf-wiki/agent";
import type { SessionUsage, WorkspaceConfig } from "@okf-wiki/contract";
import { sessionKey } from "../session-key.ts";
import {
  deletingSessions,
  disposeLive,
  type LiveAgentSessionSummary,
  liveSessions,
  openingSessions,
  projectLiveSession,
  type RegisteredAgentSession,
  registerLive,
  sweepIdleLiveSessions,
  touchLive,
} from "./live-session-registry.ts";
import { runtimeInput } from "./runtime-input.ts";
import { composeSessionUsage, sessionUsageFromPiRows } from "./session-usage.ts";

/**
 * Bound wait for abort/idle before Session JSONL delete.
 * Fail-open: if the session never reports idle within this window, delete still
 * proceeds (dispose + disk delete) rather than hanging forever.
 */
const DELETE_SETTLE_TIMEOUT_MS = 5_000;
const DELETE_SETTLE_POLL_MS = 25;

export function defaultTitle(workspace: WorkspaceConfig): string {
  return `Wiki Agent · ${workspace.name.trim() || "workspace"}`;
}

/** Create a Pi-native SessionManager session and cache its live AgentSession. */
export async function registerAgentSession(input: {
  workspace: WorkspaceConfig;
  sessionId?: string;
  title?: string;
}): Promise<LiveAgentSessionSummary> {
  const requestedId = input.sessionId?.trim();
  if (requestedId) {
    const key = sessionKey(input.workspace.id, requestedId);
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${requestedId}`);
    }
    if (liveSessions.has(key)) {
      throw new Error(`Operator Session already exists: ${requestedId}`);
    }
  }

  const runtime = await runtimeInput(input.workspace, input.sessionId);
  if (requestedId && deletingSessions.has(sessionKey(input.workspace.id, requestedId))) {
    throw new Error(`Operator Session is being deleted: ${requestedId}`);
  }
  const handle = await createOperatorSession({
    ...runtime.input,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });
  if (deletingSessions.has(sessionKey(input.workspace.id, handle.sessionId))) {
    try {
      handle.dispose();
    } catch {
      // Already disposed.
    }
    throw new Error(`Operator Session is being deleted: ${handle.sessionId}`);
  }
  handle.session.setSessionName(input.title?.trim() || defaultTitle(input.workspace));
  return projectLiveSession(registerLive(input.workspace.id, handle, runtime.queueFixtureTurn));
}

/** Public projections for live-only Sessions that Pi has not persisted yet. */
export function listLiveAgentSessionSummaries(workspaceId: string): LiveAgentSessionSummary[] {
  sweepIdleLiveSessions();
  return [...liveSessions.values()]
    .filter((entry) => entry.workspaceId === workspaceId)
    .map(projectLiveSession);
}

/**
 * Abort any live turn, wait briefly for idle/settle, dispose the handle, then
 * delete SessionManager JSONL.
 *
 * Single-flight per key (like ensureRegistered open): concurrent deletes await
 * the same promise so the deleting barrier stays up until deletion finishes.
 */
export async function deleteAgentSession(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<{ sessionId: string; removed: number }> {
  const key = sessionKey(workspace.id, sessionId);

  const inFlightDelete = deletingSessions.get(key);
  if (inFlightDelete) return inFlightDelete;

  const flight: {
    promise?: Promise<{ sessionId: string; removed: number }>;
  } = {};
  flight.promise = (async (): Promise<{ sessionId: string; removed: number }> => {
    try {
      const inFlightOpen = openingSessions.get(key);
      if (inFlightOpen) {
        try {
          await inFlightOpen;
        } catch {
          // Open failed — nothing to dispose from that path.
        }
      }

      const live = liveSessions.get(key);
      const hadLive = Boolean(live);

      if (live) {
        await live.handle.session.abort().catch(() => undefined);
        await waitForSessionQuiet(live, DELETE_SETTLE_TIMEOUT_MS);
        disposeLive(live);
        liveSessions.delete(key);
      }

      openingSessions.delete(key);

      const result = await deleteOperatorSession(workspace.rootPath, sessionId);
      return {
        sessionId,
        removed: hadLive || result.deleted ? 1 : 0,
      };
    } finally {
      if (deletingSessions.get(key) === flight.promise) {
        deletingSessions.delete(key);
      }
    }
  })();

  deletingSessions.set(key, flight.promise);
  return flight.promise;
}

async function waitForSessionQuiet(
  entry: RegisteredAgentSession,
  timeoutMs: number,
): Promise<void> {
  // Pi isIdle + admission lock are the settle authorities. Stream turnActive is
  // a projection that may lag briefly; do not block delete on it alone.
  const isQuiet = () => {
    try {
      if (!entry.handle.session.isIdle) return false;
    } catch {
      return true;
    }
    return !entry.admittedTurnId;
  };
  if (isQuiet()) return;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const waitAdmissionClear = async () => {
    while (entry.admittedTurnId) {
      await sleep(DELETE_SETTLE_POLL_MS);
    }
  };

  await Promise.race([
    Promise.all([entry.handle.session.waitForIdle(), waitAdmissionClear()]),
    sleep(timeoutMs),
  ]);
  // Mirror busy flag after settle attempt.
  entry.busy = Boolean(entry.admittedTurnId);
}

/** History load result with optional ephemeral context-fill for SSE snapshot. */
export type AgentSessionHistoryLoad = OperatorSessionHistory & {
  sessionUsage?: SessionUsage;
};

/** Read compaction-aware operator history (Pi context path + durable details strip). */
export async function loadAgentSessionHistory(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<AgentSessionHistoryLoad | null> {
  sweepIdleLiveSessions();
  const live = liveSessions.get(sessionKey(workspace.id, sessionId));
  if (live) {
    touchLive(live);
    const piRows = projectOperatorHistoryFromManager(live.handle.session.sessionManager);
    const redactedRows = redactSensitiveValue(piRows) as readonly unknown[];
    const messages = projectOperatorAgentMessages(redactedRows);
    const sessionUsage =
      live.sessionUsage ??
      sessionUsageFromPiRows(redactedRows, { live, workspace });
    if (sessionUsage) live.sessionUsage = sessionUsage;
    return {
      sessionId: live.handle.session.sessionManager.getSessionId(),
      messages,
      ...(sessionUsage ? { sessionUsage } : {}),
    };
  }
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
