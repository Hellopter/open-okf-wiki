/** Live-runtime cache and per-session open/create/delete flights. */

import { createOperatorSession, openOperatorSession } from "@okf-wiki/agent";
import type { AgentSseActiveTool, SessionUsage, WorkspaceConfig } from "@okf-wiki/contract";
import { sessionKey } from "../session-key.ts";
import { runtimeInput } from "./runtime-input.ts";
import {
  createSessionRuntime,
  type LiveAgentSessionSummary,
  type LiveSessionRuntime,
} from "./session-runtime.ts";

type OperatorSessionHandle = Awaited<ReturnType<typeof createOperatorSession>>;

export type { LiveAgentSessionSummary } from "./session-runtime.ts";

const DEFAULT_LIVE_IDLE_TTL_MS = 30 * 60 * 1000;
let liveIdleTtlMs = DEFAULT_LIVE_IDLE_TTL_MS;

const liveSessions = new Map<string, LiveSessionRuntime>();
const openingSessions = new Map<string, Promise<LiveSessionRuntime>>();
const deletingSessions = new Map<string, Promise<{ sessionId: string; removed: number }>>();

function disposeHandle(handle: OperatorSessionHandle): void {
  try {
    handle.dispose();
  } catch {
    // Already disposed.
  }
}

/** Internal: set idle TTL (ms). Pass null to restore default. Used by test-seams. */
export function setLiveIdleTtlMs(ms: number | null): void {
  liveIdleTtlMs = ms === null || ms <= 0 ? DEFAULT_LIVE_IDLE_TTL_MS : ms;
}

export function isDeletingLiveSession(workspaceId: string, sessionId: string): boolean {
  return deletingSessions.has(sessionKey(workspaceId, sessionId));
}

export function getLiveSession(
  workspaceId: string,
  sessionId: string,
): LiveSessionRuntime | undefined {
  return liveSessions.get(sessionKey(workspaceId, sessionId));
}

export function registerLive(
  workspace: WorkspaceConfig,
  handle: OperatorSessionHandle,
  queueFixtureTurn?: (text: string, canProduce: boolean) => void,
): LiveSessionRuntime {
  const key = sessionKey(workspace.id, handle.sessionId);
  if (deletingSessions.has(key)) {
    disposeHandle(handle);
    throw new Error(`Operator Session is being deleted: ${handle.sessionId}`);
  }
  if (liveSessions.has(key)) {
    disposeHandle(handle);
    throw new Error(`Operator Session already exists: ${handle.sessionId}`);
  }
  const runtime = createSessionRuntime({ workspace, handle, queueFixtureTurn });
  liveSessions.set(key, runtime);
  return runtime;
}

/**
 * Serialize explicit create requests by key. An in-flight cold open is also an
 * existing session for create purposes, so it receives the same conflict.
 */
export async function createLiveSessionFlight(
  workspaceId: string,
  sessionId: string,
  create: () => Promise<LiveSessionRuntime>,
): Promise<LiveSessionRuntime> {
  const key = sessionKey(workspaceId, sessionId);
  if (deletingSessions.has(key)) {
    throw new Error(`Operator Session is being deleted: ${sessionId}`);
  }
  if (liveSessions.has(key) || openingSessions.has(key)) {
    throw new Error(`Operator Session already exists: ${sessionId}`);
  }

  const flight = Promise.resolve().then(create);
  openingSessions.set(key, flight);
  try {
    return await flight;
  } finally {
    if (openingSessions.get(key) === flight) openingSessions.delete(key);
  }
}

/** Wait for the current cold open before a delete removes the JSONL. */
export async function waitForOpeningLiveSession(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const inFlight = openingSessions.get(sessionKey(workspaceId, sessionId));
  if (!inFlight) return;
  try {
    await inFlight;
  } catch {
    // Failed open leaves nothing to dispose.
  }
}

/** Cache eviction only: it never deletes Pi JSONL or WikiRuns data. */
export function evictLiveSession(workspaceId: string, sessionId: string): boolean {
  const key = sessionKey(workspaceId, sessionId);
  const runtime = liveSessions.get(key);
  if (!runtime) return false;
  runtime.dispose();
  liveSessions.delete(key);
  return true;
}

export function unregisterLiveSession(runtime: LiveSessionRuntime): void {
  const key = sessionKey(runtime.workspaceId, runtime.sessionId);
  if (liveSessions.get(key) === runtime) liveSessions.delete(key);
}

/** Drop idle live handles only; persisted Pi session data is retained. */
export function sweepIdleLiveSessions(now = Date.now()): number {
  let removed = 0;
  for (const [key, runtime] of liveSessions) {
    if (!runtime.isEvictable(now, liveIdleTtlMs)) continue;
    runtime.dispose();
    liveSessions.delete(key);
    removed += 1;
  }
  return removed;
}

/** Open the exact persisted SessionManager id, sharing one cold-open flight. */
export async function ensureRegistered(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<LiveSessionRuntime> {
  const key = sessionKey(workspace.id, sessionId);
  if (deletingSessions.has(key)) {
    throw new Error(`Operator Session is being deleted: ${sessionId}`);
  }
  sweepIdleLiveSessions();
  const existing = liveSessions.get(key);
  if (existing) {
    existing.updateWorkspace(workspace);
    existing.touch();
    return existing;
  }

  const inFlight = openingSessions.get(key);
  if (inFlight) return inFlight;

  const open = async (): Promise<LiveSessionRuntime> => {
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${sessionId}`);
    }
    const runtime = await runtimeInput(workspace, sessionId);
    if (deletingSessions.has(key)) {
      throw new Error(`Operator Session is being deleted: ${sessionId}`);
    }
    const raced = liveSessions.get(key);
    if (raced) {
      raced.updateWorkspace(workspace);
      return raced;
    }
    const handle = await openOperatorSession({ ...runtime.input, sessionId });
    return registerLive(workspace, handle, runtime.queueFixtureTurn);
  };

  const flight = open();
  openingSessions.set(key, flight);
  try {
    return await flight;
  } finally {
    if (openingSessions.get(key) === flight) openingSessions.delete(key);
  }
}

/** Delete flight is per key, so create/open refuse until the cascade completes. */
export async function deleteLiveSessionFlight(
  workspaceId: string,
  sessionId: string,
  remove: () => Promise<{ sessionId: string; removed: number }>,
): Promise<{ sessionId: string; removed: number }> {
  const key = sessionKey(workspaceId, sessionId);
  const inFlight = deletingSessions.get(key);
  if (inFlight) return inFlight;

  const holder: { promise?: Promise<{ sessionId: string; removed: number }> } = {};
  holder.promise = (async () => {
    try {
      return await remove();
    } finally {
      if (deletingSessions.get(key) === holder.promise) deletingSessions.delete(key);
    }
  })();
  deletingSessions.set(key, holder.promise);
  return holder.promise;
}

export function listLiveAgentSessionSummaries(workspaceId: string): LiveAgentSessionSummary[] {
  sweepIdleLiveSessions();
  return [...liveSessions.values()]
    .filter((runtime) => runtime.workspaceId === workspaceId)
    .map((runtime) => runtime.summary());
}

/** Current genuine Pi tool update for an SSE snapshot. */
export function getActiveAgentSessionTool(
  workspaceId: string,
  sessionId: string,
): AgentSseActiveTool | undefined {
  return getLiveSession(workspaceId, sessionId)?.activeTool();
}

/** Current ephemeral context-fill for an SSE snapshot (UI only). */
export function getAgentSessionUsage(
  workspaceId: string,
  sessionId: string,
): SessionUsage | undefined {
  return getLiveSession(workspaceId, sessionId)?.sessionUsage();
}

/** Process shutdown / test reset. */
export function disposeAllLiveSessions(): void {
  for (const runtime of liveSessions.values()) runtime.dispose();
  liveSessions.clear();
}

/** Test-only registry reset delegates through runtime disposal. */
export function resetLiveSessionRegistry(): void {
  disposeAllLiveSessions();
  openingSessions.clear();
  deletingSessions.clear();
  setLiveIdleTtlMs(null);
}
