/**
 * Ephemeral fan-out for live Operator Session SSE frames.
 *
 * Durable history comes from SessionManager and is sent as the first SSE
 * snapshot. Live frames are server-projected stream patches (not raw Pi).
 * This module deliberately has no replay, sequence, or product event channel.
 */
import type { AgentSseEvent } from "@okf-wiki/contract";
import { sessionKey } from "./session-key.ts";

/** Live bus carries stream patches (and any AgentSseEvent for tests). */
export type AgentSessionEventListener = (event: AgentSseEvent) => void;

const listeners = new Map<string, Set<AgentSessionEventListener>>();

/** Forward one event emitted by the live parent AgentSession path. */
export function emitAgentSessionEvent(
  workspaceId: string,
  sessionId: string,
  event: AgentSseEvent,
): AgentSseEvent {
  const current = listeners.get(sessionKey(workspaceId, sessionId));
  if (!current) return event;
  for (const listener of current) {
    try {
      listener(event);
    } catch {
      // A disconnected response must not break the parent AgentSession.
    }
  }
  return event;
}

export function subscribeAgentSessionEvents(
  workspaceId: string,
  sessionId: string,
  listener: AgentSessionEventListener,
): () => void {
  const key = sessionKey(workspaceId, sessionId);
  const current = listeners.get(key) ?? new Set<AgentSessionEventListener>();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

/** Test helper. */
export function resetAgentSessionEventBusesForTests(): void {
  listeners.clear();
}
