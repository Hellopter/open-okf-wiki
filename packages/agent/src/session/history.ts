/**
 * Operator-facing history projection from Pi SessionManager.
 *
 * Extracted from operator-session so projection stays independent of
 * session open/create/delete lifecycle.
 *
 * Two read models (both from Pi JSONL — no second database):
 * 1. **Full branch transcript** (`getBranch`) — default chat history + audit;
 *    includes compacted messages and compaction markers.
 * 2. **Active model context** (`buildContextEntries`) — diagnostic inspector
 *    for "what the model sees now"; must not impersonate chat history.
 */

import type { Message } from "@earendil-works/pi-ai";
import {
  type SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type AgentMessage, projectAgentMessagesFromPiHistory } from "@okf-wiki/contract/stream-server";

function projectEntries(manager: SessionManager, mode: "branch" | "context"): Message[] {
  const entries = mode === "branch" ? manager.getBranch() : manager.buildContextEntries();
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry) as Message[]);
}

/**
 * Full branch transcript: leaf path including pre-compaction messages and
 * compaction markers. Default Operator chat history and audit material.
 */
export function projectOperatorBranchHistoryFromManager(manager: SessionManager): Message[] {
  return projectEntries(manager, "branch");
}

/**
 * Active model context: compaction-aware entries the model would see next.
 * Diagnostic inspector only — not chat history.
 */
export function projectOperatorContextHistoryFromManager(manager: SessionManager): Message[] {
  return projectEntries(manager, "context");
}

/**
 * Default operator history = full branch transcript (not model context).
 * Compaction markers appear as system rows; pre-compact messages remain.
 */
export function projectOperatorHistoryFromManager(manager: SessionManager): Message[] {
  return projectOperatorBranchHistoryFromManager(manager);
}

/**
 * Same durable Pi branch as {@link projectOperatorHistoryFromManager}, projected
 * into the shared AgentMessage wire shape (contract parsers).
 */
export function projectOperatorAgentMessagesFromManager(manager: SessionManager): AgentMessage[] {
  return projectAgentMessagesFromPiHistory(projectOperatorHistoryFromManager(manager));
}

/** Active model context as AgentMessage[] (inspector / diagnostics). */
export function projectOperatorContextAgentMessagesFromManager(
  manager: SessionManager,
): AgentMessage[] {
  return projectAgentMessagesFromPiHistory(projectOperatorContextHistoryFromManager(manager));
}

/** Project already-stripped Pi history rows into AgentMessage[]. */
export function projectOperatorAgentMessages(rows: readonly unknown[]): AgentMessage[] {
  return projectAgentMessagesFromPiHistory(rows);
}
