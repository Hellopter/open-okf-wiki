/**
 * Test-only hooks for the agent-session live registry.
 * Production code must not import these (*ForTests / architecture guard).
 */

import type { WorkspaceConfig } from "@okf-wiki/contract";
import { emitAgentSessionEvent } from "../agent-session-events.ts";
import { projectLiveStreamEvent, projectPiEventForSse } from "../project-pi-sse.ts";
import { sessionKey } from "../session-key.ts";
import {
  deletingSessions,
  disposeLive,
  ensureRegistered,
  liveSessions,
  openingSessions,
  setLiveIdleTtlMs,
} from "./live-session-registry.ts";
import { clearAllPendingGates, rejectPendingGate } from "./wiki-produce-gate-coordinator.ts";

/** Test helper: set idle TTL (ms). Pass null to restore default. */
export function setLiveSessionIdleTtlForTests(ms: number | null): void {
  setLiveIdleTtlMs(ms);
}

/** Test helper: drop the live handle without cascading disk delete. */
export function evictLiveAgentSessionForTests(workspaceId: string, sessionId: string): void {
  const key = sessionKey(workspaceId, sessionId);
  const live = liveSessions.get(key);
  if (live) {
    disposeLive(live);
    liveSessions.delete(key);
  }
  openingSessions.delete(key);
  rejectPendingGate(key, new Error("test evict"));
}

/** Test helper: mark product busy flag without poking Pi. */
export function markLiveSessionBusyForTests(
  workspaceId: string,
  sessionId: string,
  busy: boolean,
): void {
  const entry = liveSessions.get(sessionKey(workspaceId, sessionId));
  if (entry) entry.busy = busy;
}

/** Test helper: set lastActivityAt for idle sweep tests. */
export function ageLiveSessionForTests(
  workspaceId: string,
  sessionId: string,
  lastActivityAt: number,
): void {
  const entry = liveSessions.get(sessionKey(workspaceId, sessionId));
  if (entry) entry.lastActivityAt = lastActivityAt;
}

/**
 * Test helper: inject durable Pi messages via SessionManager.appendMessage
 * without exporting the live handle as a public surface.
 */
export async function injectDurableMessagesForTests(
  workspace: WorkspaceConfig,
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content: unknown; timestamp?: number }>,
): Promise<void> {
  const entry = await ensureRegistered(workspace, sessionId);
  for (const message of messages) {
    entry.handle.session.sessionManager.appendMessage(message as never);
  }
}

/**
 * Test helper: project a raw Pi-shaped event through the product SSE bus.
 * Prefer the live entry's stream state when registered (matches production).
 */
export function emitProductSseForTests(
  workspaceId: string,
  sessionId: string,
  rawPiEvent: unknown,
): void {
  const entry = liveSessions.get(sessionKey(workspaceId, sessionId));
  if (entry) {
    const advanced = projectLiveStreamEvent(sessionId, entry.streamState, rawPiEvent);
    entry.streamState = advanced.state;
    emitAgentSessionEvent(workspaceId, sessionId, advanced.frame);
    return;
  }
  emitAgentSessionEvent(
    workspaceId,
    sessionId,
    projectPiEventForSse(workspaceId, sessionId, rawPiEvent),
  );
}

/** Test helper. */
export function resetAgentSessionRegistryForTests(): void {
  for (const entry of liveSessions.values()) disposeLive(entry);
  liveSessions.clear();
  openingSessions.clear();
  deletingSessions.clear();
  clearAllPendingGates("test reset");
  setLiveSessionIdleTtlForTests(null);
}
