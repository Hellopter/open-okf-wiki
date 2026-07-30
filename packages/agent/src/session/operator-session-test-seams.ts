/**
 * Test-only seams over Pi public SessionManager APIs.
 *
 * Prefer these over poking AgentSession private fields (_eventListeners, etc.).
 * Production code must not import this module — use `@okf-wiki/agent/testing`
 * from tests only (enforced by check-architecture).
 */

import type { Message } from "@earendil-works/pi-ai";
import {
  type OperatorSessionHandle,
  projectOperatorHistoryFromManager,
} from "./operator-session.js";

/**
 * Append durable messages onto the operator SessionManager branch
 * via Pi public `sessionManager.appendMessage`.
 */
export function injectDurableOperatorMessages(
  handle: OperatorSessionHandle,
  messages: readonly Message[],
): void {
  for (const message of messages) {
    handle.session.sessionManager.appendMessage(message);
  }
}

/**
 * Read full-branch durable operator history from the live handle
 * (same projection as loadOperatorSessionHistory after open).
 */
export function readDurableOperatorBranchMessages(handle: OperatorSessionHandle): Message[] {
  return projectOperatorHistoryFromManager(handle.session.sessionManager);
}

/**
 * Read raw SessionManager branch messages without product history projection.
 * Prefer this when tests must assert Pi storage was not mutated (secrets, fat details).
 * Encapsulates SessionManager.getBranch() so tests never deep-chain Pi APIs.
 */
export function readRawOperatorBranchMessages(handle: OperatorSessionHandle): Message[] {
  const messages: Message[] = [];
  for (const row of handle.session.sessionManager.getBranch()) {
    if (row.type === "message") {
      messages.push(row.message as Message);
    }
  }
  return messages;
}
