/**
 * Create / delete / list Operator Sessions and cascade Run data on delete.
 */

import {
  createOperatorSession,
  deleteOperatorSession,
  type GatePort,
  loadOperatorSessionHistory,
  type OperatorSessionHistory,
  projectOperatorHistoryFromManager,
  redactSensitiveValue,
} from "@okf-wiki/agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
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
import { gateCoordinator, rejectPendingGate } from "./wiki-produce-gate-coordinator.ts";

/**
 * Bound wait for abort/idle before cascading Session delete.
 * Fail-open: if the session never reports idle within this window, delete still
 * proceeds (dispose + disk cascade) rather than hanging forever.
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
    // Delete barrier first: mid-cascade the dying live entry may still be present,
    // but create must report "being deleted" rather than "already exists".
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${requestedId}`);
    }
    if (liveSessions.has(key)) {
      throw new Error(`Operator Session already exists: ${requestedId}`);
    }
  }

  // A generated id must be known before constructing the gate coordinator. Pi
  // accepts an omitted id, so create once then bind the coordinator through a
  // stable wrapper that resolves the final id lazily.
  let resolvedSessionId = input.sessionId?.trim() ?? "";
  const coordinator: GatePort = {
    waitForDecision(request, signal) {
      return gateCoordinator(input.workspace.id, resolvedSessionId).waitForDecision(
        request,
        signal,
      );
    },
  };
  const runtime = await runtimeInput(input.workspace, input.sessionId);
  // Re-check after await: a delete may have started for the requested id.
  if (requestedId && deletingSessions.has(sessionKey(input.workspace.id, requestedId))) {
    throw new Error(`Operator Session is being deleted: ${requestedId}`);
  }
  const handle = await createOperatorSession({
    ...runtime.input,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    wikiProduce: { ...runtime.input.wikiProduce, gateCoordinator: coordinator },
  });
  resolvedSessionId = handle.sessionId;
  // Final barrier before registerLive (covers client-chosen id races mid-create).
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
 * cascade v2 Run data + SessionManager JSONL. Gate waiters are rejected first
 * so wiki_produce cannot keep writing after delete begins.
 *
 * Single-flight per key (like ensureRegistered open): concurrent deletes await
 * the same promise so the deleting barrier stays up until the cascade finishes.
 * Also serialized against cold open: marks deleting, awaits any in-flight open
 * (disposing a late-arriving handle via the deleting map), then tears down.
 */
export async function deleteAgentSession(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<{ sessionId: string; removed: number }> {
  const key = sessionKey(workspace.id, sessionId);

  const inFlightDelete = deletingSessions.get(key);
  if (inFlightDelete) return inFlightDelete;

  // Box so the finally ownership check can compare the same promise without TDZ.
  const flight: {
    promise?: Promise<{ sessionId: string; removed: number }>;
  } = {};
  flight.promise = (async (): Promise<{ sessionId: string; removed: number }> => {
    try {
      // Unblock gate waiters before filesystem cascade so tool catch can finish.
      rejectPendingGate(key, new Error("Wiki Run cancelled"));

      // Await the cold-open single-flight so we can dispose its handle. Without
      // this, openOperatorSession + registerLive can finish after disk delete and
      // reanimate a “deleted” session.
      const inFlightOpen = openingSessions.get(key);
      if (inFlightOpen) {
        try {
          await inFlightOpen;
        } catch {
          // Open failed or was cancelled by the deleting flag — nothing to dispose
          // from that path (handle disposed inside ensureRegistered if needed).
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

      // Open's finally may already have cleared this; drop any stale entry.
      openingSessions.delete(key);

      const result = await deleteOperatorSession(workspace.rootPath, sessionId);
      return {
        sessionId,
        removed: (hadLive || result.deleted ? 1 : 0) + result.removedRunIds.length,
      };
    } finally {
      // Only the owning flight clears the barrier (single-flight, not refcount).
      if (deletingSessions.get(key) === flight.promise) {
        deletingSessions.delete(key);
      }
    }
  })();

  // Mark before any outer await so concurrent create/open/delete see the barrier.
  deletingSessions.set(key, flight.promise);
  return flight.promise;
}

/**
 * Wait until the AgentSession reports idle and the registry busy flag clears,
 * or until the timeout elapses. Fail-open: timeout resolves without error so
 * delete can still dispose and cascade disk (never hangs forever).
 * Prefers Pi `waitForIdle()` over polling private event listeners.
 */
async function waitForSessionQuiet(
  entry: RegisteredAgentSession,
  timeoutMs: number,
): Promise<void> {
  if (entry.handle.session.isIdle && !entry.busy) return;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const waitBusyClear = async () => {
    while (entry.busy) {
      await sleep(DELETE_SETTLE_POLL_MS);
    }
  };

  await Promise.race([
    Promise.all([entry.handle.session.waitForIdle(), waitBusyClear()]),
    sleep(timeoutMs),
  ]);
}

/** Read compaction-aware operator history (Pi context path + durable details strip). */
export async function loadAgentSessionHistory(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<OperatorSessionHistory | null> {
  sweepIdleLiveSessions();
  const live = liveSessions.get(sessionKey(workspace.id, sessionId));
  if (live) {
    touchLive(live);
    // Compaction-aware projection (Pi TUI path); strip fat wiki_produce details.
    const messages = projectOperatorHistoryFromManager(live.handle.session.sessionManager);
    return {
      sessionId: live.handle.session.sessionManager.getSessionId(),
      // Operator snapshot only — do not mutate Pi-owned message objects.
      messages: redactSensitiveValue(messages),
    };
  }
  const history = await loadOperatorSessionHistory(workspace.rootPath, sessionId);
  if (!history) return null;
  return {
    sessionId: history.sessionId,
    messages: redactSensitiveValue(history.messages),
  };
}
