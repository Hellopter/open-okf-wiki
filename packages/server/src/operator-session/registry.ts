/**
 * Live Operator Session registry: in-memory handles, open-dedupe, and retire/close.
 *
 * Single source of truth for liveSessions / openingLiveSessions / retiredWorkspaceIds.
 * No SessionStore port — Pi SessionManager remains durable storage.
 */
import { type createOperatorSession } from "@okf-wiki/agent";
import type {
  AgentSseEvent,
  AgentSessionContextBudget,
  AgentSessionModel,
  SessionUsage,
} from "@okf-wiki/contract/session";
import type { PiStreamState } from "@okf-wiki/contract/stream-server";
import type { WorkspaceActivityLease } from "@okf-wiki/core";

export type SessionHandle = Awaited<ReturnType<typeof createOperatorSession>>;
export type Listener = (event: AgentSseEvent) => void;
export type ListenerSubscription = {
  onEvent: Listener;
  onClosed?: () => void;
};
export type FixtureTurnQueue = (text: string, canProduce: boolean) => void;
export type BuiltHandle = {
  handle: SessionHandle;
  queueFixtureTurn?: FixtureTurnQueue;
  /** Live chat model bound when the handle was opened. */
  model?: AgentSessionModel;
  /** Seat budget derived from model window + workspace target. */
  contextBudget?: AgentSessionContextBudget;
};

export type LiveSession = {
  workspaceId: string;
  sessionId: string;
  handle: SessionHandle;
  state: PiStreamState;
  listeners: Set<ListenerSubscription>;
  busy: boolean;
  createdAt: string;
  updatedAt: string;
  unsubscribe: () => void;
  activityLease: WorkspaceActivityLease;
  closed: boolean;
  sessionUsage?: SessionUsage;
  /** Session-scoped chat model (not workspace default; not disk-persisted). */
  model?: AgentSessionModel;
  /** Seat context budget for chrome + sessionUsage denominators. */
  contextBudget?: AgentSessionContextBudget;
  queueFixtureTurn?: FixtureTurnQueue;
};

/** One live registry for the process — do not duplicate. */
export const liveSessions = new Map<string, LiveSession>();
/** In-flight open dedupe so concurrent openLive for the same key share one promise. */
export const openingLiveSessions = new Map<string, Promise<LiveSession>>();
/** Workspaces fenced after deletion until process restore/clear. */
export const retiredWorkspaceIds = new Set<string>();

export function key(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:${sessionId}`;
}

export function emit(live: LiveSession, event: AgentSseEvent): void {
  for (const listener of live.listeners) listener.onEvent(event);
}

export async function releaseLive(live: LiveSession): Promise<void> {
  if (live.closed) return;
  live.closed = true;
  try {
    if (live.busy) {
      await live.handle.session.abort().catch(() => undefined);
      live.busy = false;
    }
  } finally {
    try {
      live.unsubscribe();
      live.handle.dispose();
      const sessionKey = key(live.workspaceId, live.sessionId);
      if (liveSessions.get(sessionKey) === live) liveSessions.delete(sessionKey);
      for (const listener of [...live.listeners]) listener.onClosed?.();
      live.listeners.clear();
    } finally {
      await live.activityLease.release();
    }
  }
}

/**
 * Abort and close all active Session handles for one changed Workspace.
 * Pi JSONL stays untouched; a following request reopens it with a fresh
 * Workspace configuration snapshot.
 */
export async function invalidateOperatorSessions(
  workspaceId: string,
  _reason = "workspace configuration changed",
): Promise<number> {
  const pending = [...openingLiveSessions.entries()]
    .filter(([sessionKey]) => sessionKey.startsWith(`${workspaceId}:`))
    .map(([, opening]) => opening.catch(() => undefined));
  await Promise.all(pending);
  const targets = [...liveSessions.values()].filter((live) => live.workspaceId === workspaceId);
  await Promise.all(targets.map((live) => releaseLive(live)));
  return targets.length;
}

/** Fence deleted workspaces before closing their active Pi Session handles. */
export async function retireOperatorSessionsForDeletedWorkspace(
  workspaceId: string,
): Promise<number> {
  retiredWorkspaceIds.add(workspaceId);
  return invalidateOperatorSessions(workspaceId, "workspace deleted");
}

/** Reopen the Session boundary when workspace deletion fails before removal. */
export function restoreOperatorSessionsAfterFailedWorkspaceDeletion(workspaceId: string): void {
  retiredWorkspaceIds.delete(workspaceId);
}

/** Graceful process shutdown closes Pi handles and all Session SSE subscribers. */
export async function closeOperatorSessions(): Promise<void> {
  try {
    await Promise.all(
      [...openingLiveSessions.values()].map((opening) => opening.catch(() => undefined)),
    );
    await Promise.all([...liveSessions.values()].map((live) => releaseLive(live)));
  } finally {
    retiredWorkspaceIds.clear();
  }
}
