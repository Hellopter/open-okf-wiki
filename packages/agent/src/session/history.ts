/**
 * Operator-facing history projection from Pi SessionManager.
 *
 * Extracted from operator-session so projection stays independent of
 * session open/create/delete lifecycle.
 *
 * Two layers:
 * 1. Pi Message[] with lean wiki_produce details (durable JSONL-facing strip)
 * 2. Optional AgentMessage[] via contract projectAgentMessagesFromPiHistory
 *    (same wire shape as web SSE snapshot projection)
 */

import type { Message } from "@earendil-works/pi-ai";
import {
  type SessionManager,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentMessage,
  projectAgentMessagesFromPiHistory,
  projectWikiProduceDetailsForHistory,
} from "@okf-wiki/contract";

/**
 * Operator-facing history projection of one Pi message.
 * Clones wiki_produce toolResult.details to a durable (lean) shape; does not
 * mutate SessionManager-owned objects.
 */
export function projectOperatorHistoryMessage(message: Message): Message {
  if (!message || typeof message !== "object") return message;
  const row = message as Message & {
    role?: string;
    toolName?: string;
    details?: unknown;
  };
  if (row.role !== "toolResult") return message;
  // Always project: projectWikiProduceDetailsForHistory no-ops unless status is a wiki_produce status.
  if (!("details" in row) || row.details == null) return message;
  const projected = projectWikiProduceDetailsForHistory(row.details);
  if (projected === row.details) return message;
  return { ...row, details: projected } as Message;
}

/**
 * Operator UI history from a SessionManager: Pi compaction-aware context path
 * (same idea as TUI `buildContextEntries` + `sessionEntryToContextMessages`),
 * then product-side durable details strip. Does not rewrite JSONL.
 */
export function projectOperatorHistoryFromManager(manager: SessionManager): Message[] {
  return manager
    .buildContextEntries()
    .flatMap((entry) => sessionEntryToContextMessages(entry) as Message[])
    .map((message) => projectOperatorHistoryMessage(message));
}

/**
 * Same durable Pi branch as {@link projectOperatorHistoryFromManager}, projected
 * into the shared AgentMessage wire shape (contract parsers).
 */
export function projectOperatorAgentMessagesFromManager(manager: SessionManager): AgentMessage[] {
  return projectAgentMessagesFromPiHistory(projectOperatorHistoryFromManager(manager));
}

/** Project already-stripped Pi history rows into AgentMessage[]. */
export function projectOperatorAgentMessages(rows: readonly unknown[]): AgentMessage[] {
  return projectAgentMessagesFromPiHistory(rows);
}
