/**
 * Live-handle cache for Pi-native Operator Sessions (Map + ensure/open/evict/idle TTL).
 * Disk JSONL is never deleted here — only product-cache dispose.
 */

import { createOperatorSession, openOperatorSession } from "@okf-wiki/agent";
import type {
  AgentSseActiveTool,
  PiStreamState,
  SessionUsage,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { emitAgentSessionEvent } from "../agent-session-events.ts";
import {
  activeToolUpdate,
  initialLiveStreamState,
  projectLiveStreamEvent,
} from "../project-pi-sse.ts";
import { sessionKey } from "../session-key.ts";
import { runtimeInput } from "./runtime-input.ts";
import { sessionUsageFromPiEvent } from "./session-usage.ts";

type OperatorSessionHandle = Awaited<ReturnType<typeof createOperatorSession>>;

/** Internal live entry — not a public test surface for Pi handles. */
export type RegisteredAgentSession = {
  handle: OperatorSessionHandle;
  workspaceId: string;
  /**
   * Admission lock for a detached prompt turn. Set on HTTP admission; cleared
   * when the prompt promise settles (after agent_settled). Prefer this over a
   * separate busy boolean that can disagree with Pi settled state.
   */
  admittedTurnId?: string;
  /**
   * @deprecated Use admittedTurnId / SessionRuntime.isBusy(). Kept as a mirror
   * for idle-sweep and delete settle until callers migrate.
   */
  busy: boolean;
  /** Wall-clock ms of last product touch (prompt, gate, open, live event). */
  lastActivityAt: number;
  unsubscribe: () => void;
  activeTool?: AgentSseActiveTool;
  /** Server-owned live stream reduce state (view projection). */
  streamState: PiStreamState;
  /**
   * Ephemeral context-fill for Operator chrome (last assistant totalTokens +
   * budget). Updated on message_end with usage; not durable control truth.
   */
  sessionUsage?: SessionUsage;
  queueFixtureTurn?: (text: string, canProduce: boolean) => void;
};

export type LiveAgentSessionSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

/** Default idle before disposeLive; disk JSONL is kept (Pi SessionManager.open on next use). */
const DEFAULT_LIVE_IDLE_TTL_MS = 30 * 60 * 1000;
let liveIdleTtlMs = DEFAULT_LIVE_IDLE_TTL_MS;

export const liveSessions = new Map<string, RegisteredAgentSession>();
/** Single-flight open for cold ensureRegistered (one SessionManager per JSONL). */
export const openingSessions = new Map<string, Promise<RegisteredAgentSession>>();
/**
 * Single-flight delete per key (mirrors openingSessions). Concurrent deletes await
 * the same promise; create/open check `.has(key)` so they cannot registerLive while
 * a cascade is in progress. Cleared only when that flight finishes.
 */
export const deletingSessions = new Map<string, Promise<{ sessionId: string; removed: number }>>();

/** Internal: set idle TTL (ms). Pass null to restore default. Used by test-seams. */
export function setLiveIdleTtlMs(ms: number | null): void {
  liveIdleTtlMs = ms === null || ms <= 0 ? DEFAULT_LIVE_IDLE_TTL_MS : ms;
}

export function touchLive(entry: RegisteredAgentSession): void {
  entry.lastActivityAt = Date.now();
}

export function disposeLive(entry: RegisteredAgentSession): void {
  try {
    entry.unsubscribe();
  } catch {
    // Already detached.
  }
  try {
    entry.handle.dispose();
  } catch {
    // Already disposed.
  }
}

export function registerLive(
  workspaceId: string,
  handle: OperatorSessionHandle,
  queueFixtureTurn?: (text: string, canProduce: boolean) => void,
): RegisteredAgentSession {
  const key = sessionKey(workspaceId, handle.sessionId);
  const prior = liveSessions.get(key);
  if (prior) disposeLive(prior);

  const entry: RegisteredAgentSession = {
    handle,
    workspaceId,
    busy: false,
    lastActivityAt: Date.now(),
    unsubscribe: () => undefined,
    streamState: initialLiveStreamState(),
    ...(queueFixtureTurn ? { queueFixtureTurn } : {}),
  };
  entry.unsubscribe = handle.session.subscribe((event) => {
    touchLive(entry);
    const tool = activeToolUpdate(event);
    if (tool === null) delete entry.activeTool;
    else if (tool) entry.activeTool = tool;
    // Server reduces Pi → stream view patch (redacted); web only applies.
    const advanced = projectLiveStreamEvent(handle.sessionId, entry.streamState, event);
    entry.streamState = advanced.state;
    // Keep deprecated busy mirror aligned with admission + turnActive (no dual truth).
    entry.busy = Boolean(entry.admittedTurnId) || entry.streamState.turnActive;
    // Context-fill chip: refresh from assistant message_end usage when present.
    const usageUpdate = sessionUsageFromPiEvent(event, entry.sessionUsage, { live: entry });
    if (usageUpdate) {
      entry.sessionUsage = usageUpdate;
      advanced.frame = {
        ...advanced.frame,
        payload: {
          ...advanced.frame.payload,
          sessionUsage: usageUpdate,
          contextPhase: advanced.state.contextPhase,
        },
      };
    } else if (advanced.frame.payload.contextPhase === undefined) {
      advanced.frame = {
        ...advanced.frame,
        payload: {
          ...advanced.frame.payload,
          contextPhase: advanced.state.contextPhase,
        },
      };
    }
    // On agent_settled, admission is already released by the detached finally;
    // ensure busy mirror clears if stream says idle.
    if (
      event &&
      typeof event === "object" &&
      "type" in event &&
      (event as { type: unknown }).type === "agent_settled"
    ) {
      entry.busy = Boolean(entry.admittedTurnId);
    }
    emitAgentSessionEvent(workspaceId, handle.sessionId, advanced.frame);
  });
  liveSessions.set(key, entry);
  return entry;
}

export function projectLiveSession(entry: RegisteredAgentSession): LiveAgentSessionSummary {
  const manager = entry.handle.session.sessionManager;
  const header = manager.getHeader();
  if (!header) throw new Error("Pi did not initialize the Operator Session");
  return {
    id: manager.getSessionId(),
    title: manager.getSessionName()?.trim() || undefined,
    createdAt: header.timestamp,
    updatedAt: manager.getBranch().at(-1)?.timestamp ?? header.timestamp,
  };
}

/**
 * Drop idle live handles only (product cache). Never deletes JSONL or Run data.
 * Skips busy sessions, pending gates, and non-idle AgentSession turns.
 */
export function sweepIdleLiveSessions(now = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of liveSessions) {
    if (entry.admittedTurnId || entry.busy || entry.streamState.turnActive) continue;
    try {
      if (!entry.handle.session.isIdle) continue;
    } catch {
      // Treat broken handles as evictable.
    }
    if (now - entry.lastActivityAt < liveIdleTtlMs) continue;
    disposeLive(entry);
    liveSessions.delete(key);
    removed += 1;
  }
  return removed;
}

/**
 * Open the exact SessionManager id; never scan legacy metadata or cwd stores.
 * Concurrent cold opens share one in-flight promise so only one SessionManager
 * is constructed against the JSONL. A concurrent delete wins: the open disposes
 * its handle and rejects rather than reanimating a deleted session.
 */
export async function ensureRegistered(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<RegisteredAgentSession> {
  const key = sessionKey(workspace.id, sessionId);
  if (deletingSessions.has(key)) {
    throw new Error(`Operator Session is being deleted: ${sessionId}`);
  }
  // Opportunistic product-cache GC (does not touch disk JSONL).
  sweepIdleLiveSessions();
  const existing = liveSessions.get(key);
  if (existing) {
    touchLive(existing);
    return existing;
  }

  const inFlight = openingSessions.get(key);
  if (inFlight) return inFlight;

  const openPromise = (async (): Promise<RegisteredAgentSession> => {
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${sessionId}`);
    }
    // Re-check after any prior await inside open; another path may have registered.
    const raced = liveSessions.get(key);
    if (raced) return raced;
    const runtime = await runtimeInput(workspace, sessionId);
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${sessionId}`);
    }
    const again = liveSessions.get(key);
    if (again) return again;
    const handle = await openOperatorSession({ ...runtime.input, sessionId });
    // Delete may have started while openOperatorSession was in flight. Dispose
    // immediately and reject so waiters never observe a resurrected live entry.
    if (deletingSessions.has(key)) {
      try {
        handle.dispose();
      } catch {
        // Already disposed.
      }
      throw new Error(`Operator Session was deleted during open: ${sessionId}`);
    }
    return registerLive(workspace.id, handle, runtime.queueFixtureTurn);
  })();

  openingSessions.set(key, openPromise);
  try {
    return await openPromise;
  } finally {
    // Clear on both success and failure so retries can re-open after a failed open.
    if (openingSessions.get(key) === openPromise) {
      openingSessions.delete(key);
    }
  }
}

/** Current genuine Pi tool update for an SSE snapshot; never reconstructed from a Run Record. */
export function getActiveAgentSessionTool(
  workspaceId: string,
  sessionId: string,
): AgentSseActiveTool | undefined {
  return liveSessions.get(sessionKey(workspaceId, sessionId))?.activeTool;
}

/** Current ephemeral context-fill for an SSE snapshot (UI only). */
export function getAgentSessionUsage(
  workspaceId: string,
  sessionId: string,
): SessionUsage | undefined {
  return liveSessions.get(sessionKey(workspaceId, sessionId))?.sessionUsage;
}
