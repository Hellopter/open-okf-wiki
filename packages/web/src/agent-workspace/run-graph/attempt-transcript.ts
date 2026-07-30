/**
 * Project opaque Attempt transcript messages into AgentMessage[] for Node details.
 *
 * Same wire shape Session uses — render with TranscriptMessage / TranscriptMessageList
 * (AgentMarkdown + ToolExecutionCard). Do not reimplement markdown chrome here.
 *
 * Messages come from GET transcript (done) or Attempt transcript SSE (live).
 */

import type { AgentMessage, AgentToolCall, AgentToolCallStatus } from "@okf-wiki/contract";
import {
  extractMessageText,
  isRecord,
  makeId,
  projectAgentMessagesFromPiHistory,
} from "@okf-wiki/contract";

const CONTENT_MAX = 12_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
        continue;
      }
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n").trim();
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function mapToolStatus(raw: unknown): AgentToolCallStatus {
  if (raw === "running" || raw === "pending" || raw === "error" || raw === "done") return raw;
  if (raw === "ok" || raw === "succeeded" || raw === "success") return "done";
  if (raw === "failed") return "error";
  return "done";
}

function parseArgs(raw: unknown): unknown {
  if (raw == null || raw === "") return undefined;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

const TOOL_TYPES = new Set([
  "tool",
  "toolCall",
  "tool_call",
  "toolResult",
  "tool_result",
  "tool_use",
  "function_call",
  "functionCall",
]);

function isToolish(entry: Record<string, unknown>): boolean {
  if (typeof entry.toolName === "string" && entry.toolName.trim()) return true;
  if (typeof entry.type === "string" && TOOL_TYPES.has(entry.type)) return true;
  if (entry.role === "toolResult" || entry.role === "tool") return true;
  if (
    typeof entry.name === "string" &&
    entry.name.trim() &&
    !("role" in entry && "content" in entry) &&
    ("arguments" in entry || "args" in entry || "input" in entry || "argsSummary" in entry)
  ) {
    return true;
  }
  return false;
}

/**
 * Legacy metadata-only stub from early WikiRuns attempts:
 * `{ schema: 1, node, summary, mode, … }` without role/content.
 */
function isLegacyMetadataStub(row: Record<string, unknown>): boolean {
  if (typeof row.role === "string" && "content" in row) return false;
  if (row.type === "text" || row.type === "toolCall") return false;
  if (isToolish(row)) return false;
  return (
    (row.schema === 1 || typeof row.node === "string" || typeof row.attemptId === "string") &&
    (typeof row.summary === "string" ||
      typeof row.error === "string" ||
      typeof row.mode === "string")
  );
}

function toolFromRow(row: Record<string, unknown>, index: number): AgentToolCall {
  const name =
    (typeof row.toolName === "string" && row.toolName.trim()) ||
    (typeof row.name === "string" && row.name.trim()) ||
    "tool";
  const id =
    (typeof row.id === "string" && row.id.trim()) ||
    (typeof row.toolCallId === "string" && row.toolCallId.trim()) ||
    `att_tool_${index + 1}`;
  const args = parseArgs(row.arguments ?? row.args ?? row.input ?? row.argsSummary);
  const status = mapToolStatus(row.status);
  const output =
    typeof row.output === "string"
      ? row.output
      : typeof row.result === "string"
        ? row.result
        : undefined;
  return {
    id,
    name,
    ...(args !== undefined ? { args } : {}),
    ...(output !== undefined ? { output } : {}),
    status,
  };
}

function assistantWithTools(tools: AgentToolCall[], index: number, text?: string): AgentMessage {
  const createdAt = new Date().toISOString();
  const content = text?.trim() ?? "";
  const parts: AgentMessage["parts"] = [];
  if (content) parts.push({ type: "text", text: content });
  for (const tool of tools) parts.push({ type: "tool", toolId: tool.id });
  return {
    id: `att_asst_${index + 1}_${makeId("t")}`,
    role: "assistant",
    content,
    createdAt,
    status: "done",
    tools,
    ...(parts.length > 0 ? { parts } : {}),
  };
}

/**
 * Map opaque transcript rows to AgentMessage[] (Session wire shape).
 *
 * Recognises:
 * - Pi history `{ role, content }` / toolResult (via projectAgentMessagesFromPiHistory)
 * - AttemptItem `{ type: "text" | "toolCall", … }` from attempt-transcript-sink
 * - legacy metadata stubs with `summary`
 */
export function projectAttemptTranscriptMessages(messages: unknown[]): AgentMessage[] {
  // Fast path: pure Pi Session history rows.
  const looksLikePiHistory =
    messages.length > 0 &&
    messages.every((row) => {
      if (!isRecord(row)) return false;
      const role = typeof row.role === "string" ? row.role : null;
      return role === "user" || role === "assistant" || role === "toolResult" || role === "tool";
    });
  if (looksLikePiHistory) {
    const projected = projectAgentMessagesFromPiHistory(messages);
    if (projected.length > 0) return projected;
  }

  const out: AgentMessage[] = [];
  const createdAt = new Date().toISOString();

  for (let index = 0; index < messages.length; index += 1) {
    const row = messages[index];
    if (!isRecord(row)) {
      out.push({
        id: `att_raw_${index + 1}`,
        role: "system",
        content: truncate(
          (() => {
            try {
              return JSON.stringify(row);
            } catch {
              return String(row);
            }
          })(),
          240,
        ),
        createdAt,
        status: "done",
      });
      continue;
    }

    // AttemptItem text row from attempt-transcript-sink.
    if (row.type === "text" && typeof row.text === "string") {
      const text = truncate(row.text, CONTENT_MAX);
      if (!text) continue;
      out.push({
        id: `att_text_${index + 1}`,
        role: "assistant",
        content: text,
        createdAt,
        status: "done",
        parts: [{ type: "text", text }],
      });
      continue;
    }

    // AttemptItem toolCall row or loose tool-ish object.
    if (
      (row.type === "toolCall" && typeof row.name === "string") ||
      (isToolish(row) && !(typeof row.role === "string" && "content" in row))
    ) {
      out.push(assistantWithTools([toolFromRow(row, index)], index));
      continue;
    }

    // Pi-ish chat: role + content.
    if (typeof row.role === "string" && "content" in row) {
      const role = row.role;
      if (role === "user") {
        out.push({
          id: `att_user_${index + 1}`,
          role: "user",
          content: truncate(contentToText(row.content) || extractMessageText(row), CONTENT_MAX),
          createdAt,
          status: "done",
        });
        continue;
      }
      if (role === "assistant") {
        const text = truncate(contentToText(row.content) || extractMessageText(row), CONTENT_MAX);
        out.push({
          id: `att_asst_${index + 1}`,
          role: "assistant",
          content: text || "(empty)",
          createdAt,
          status: "done",
          ...(text ? { parts: [{ type: "text" as const, text }] } : {}),
        });
        continue;
      }
      if (role === "system" || role === "tool") {
        out.push({
          id: `att_sys_${index + 1}`,
          role: role === "tool" ? "tool" : "system",
          content: truncate(contentToText(row.content), CONTENT_MAX) || "(empty)",
          createdAt,
          status: "done",
        });
        continue;
      }
    }

    // Old metadata-only session.jsonl stubs → readable assistant summary.
    if (isLegacyMetadataStub(row)) {
      const summary =
        (typeof row.summary === "string" && row.summary.trim()) ||
        (typeof row.error === "string" && row.error.trim()) ||
        "";
      if (summary) {
        const text = truncate(summary, CONTENT_MAX);
        out.push({
          id: `att_meta_${index + 1}`,
          role: "assistant",
          content: text,
          createdAt,
          status: "done",
          parts: [{ type: "text", text }],
        });
        continue;
      }
    }

    out.push({
      id: `att_raw_${index + 1}`,
      role: "system",
      content: truncate(
        (() => {
          try {
            return JSON.stringify(row);
          } catch {
            return String(row);
          }
        })(),
        240,
      ),
      createdAt,
      status: "done",
    });
  }

  return out;
}

/** Attempt states that open transcript SSE (dialog live stream). */
export function isAttemptTranscriptLive(state: string | null | undefined): boolean {
  return state === "running" || state === "suspended";
}
