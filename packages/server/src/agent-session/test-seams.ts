/** Test-only hooks over the live SessionRuntime behavior. */

import type { WorkspaceConfig } from "@okf-wiki/contract";
import {
  ensureRegistered,
  evictLiveSession,
  getLiveSession,
  resetLiveSessionRegistry,
  setLiveIdleTtlMs,
} from "./live-session-registry.ts";

/** Test helper: set idle TTL (ms). Pass null to restore default. */
export function setLiveSessionIdleTtlForTests(ms: number | null): void {
  setLiveIdleTtlMs(ms);
}

/** Test helper: drop the live runtime without deleting Pi JSONL. */
export function evictLiveAgentSessionForTests(workspaceId: string, sessionId: string): void {
  evictLiveSession(workspaceId, sessionId);
}

/** Append durable Pi messages through the runtime, never its raw handle. */
export async function injectDurableMessagesForTests(
  workspace: WorkspaceConfig,
  sessionId: string,
  messages: ReadonlyArray<{ role: string; content: unknown; timestamp?: number }>,
): Promise<void> {
  const runtime = await ensureRegistered(workspace, sessionId);
  runtime.appendDurableMessages(messages);
}

/** Read raw Pi branch rows only for assertions that redaction is non-mutating. */
export async function readRawLiveSessionMessagesForTests(
  workspace: WorkspaceConfig,
  sessionId: string,
): Promise<unknown[]> {
  return (await ensureRegistered(workspace, sessionId)).rawBranchMessages();
}

/** Feed a Pi-shaped event through the same runtime reducer used in production. */
export function emitProductSseForTests(
  workspaceId: string,
  sessionId: string,
  rawPiEvent: unknown,
): void {
  getLiveSession(workspaceId, sessionId)?.receivePiEvent(rawPiEvent);
}

/** Test helper. */
export function resetAgentSessionRegistryForTests(): void {
  resetLiveSessionRegistry();
}
