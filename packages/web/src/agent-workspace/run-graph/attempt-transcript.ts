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

const CONTENT_MAX = 64 * 1024;

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

function traceToolMessage(ordinal: number, at: string, tool: AgentToolCall): AgentMessage {
  return {
    id: `att_trace_${ordinal}`,
    role: "assistant",
    content: "",
    createdAt: at,
    status: "done",
    tools: [tool],
    parts: [{ type: "tool", toolId: tool.id }],
  };
}

function projectAttemptTraceEvents(rows: Record<string, unknown>[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  const toolIndexesByKey = new Map<string, number[]>();

  for (const row of rows) {
    const ordinal = typeof row.ordinal === "number" ? row.ordinal : out.length + 1;
    const createdAt = typeof row.at === "string" ? row.at : new Date().toISOString();
    const kind = row.kind;
    if (kind === "legacy") {
      const legacy = projectAttemptTranscriptMessages([row.message]);
      for (const message of legacy) {
        out.push({ ...message, id: `att_trace_legacy_${ordinal}_${message.id}` });
      }
      continue;
    }
    if (kind === "input" && typeof row.content === "string") {
      out.push({
        id: `att_trace_input_${ordinal}`,
        role: "user",
        content: row.content,
        createdAt,
        status: "done",
      });
      continue;
    }
    if (kind === "assistant" && typeof row.content === "string") {
      out.push({
        id: `att_trace_assistant_${ordinal}`,
        role: "assistant",
        content: row.content,
        createdAt,
        status: "done",
        parts: [{ type: "text", text: row.content }],
      });
      continue;
    }
    if (kind === "tool_call" && typeof row.name === "string") {
      const key =
        typeof row.toolCallId === "string" && row.toolCallId.trim()
          ? row.toolCallId
          : `name:${row.name}`;
      const tool: AgentToolCall = {
        id: `att_trace_tool_${ordinal}`,
        name: row.name,
        ...(row.args !== undefined ? { args: parseArgs(row.args) } : {}),
        status: "running",
      };
      const indexes = toolIndexesByKey.get(key) ?? [];
      indexes.push(out.length);
      toolIndexesByKey.set(key, indexes);
      out.push(traceToolMessage(ordinal, createdAt, tool));
      continue;
    }
    if (kind === "tool_result" && typeof row.name === "string") {
      const key =
        typeof row.toolCallId === "string" && row.toolCallId.trim()
          ? row.toolCallId
          : `name:${row.name}`;
      const indexes = toolIndexesByKey.get(key);
      const index = indexes?.shift();
      const status = row.status === "error" ? "error" : "done";
      if (index !== undefined) {
        const message = out[index];
        const current = message?.tools?.[0];
        if (message && current) {
          out[index] = {
            ...message,
            tools: [
              {
                ...current,
                ...(typeof row.output === "string" ? { output: row.output } : {}),
                status,
              },
            ],
          };
          if (!indexes || indexes.length === 0) toolIndexesByKey.delete(key);
          continue;
        }
      }
      out.push(
        traceToolMessage(ordinal, createdAt, {
          id: `att_trace_tool_${ordinal}`,
          name: row.name,
          ...(typeof row.output === "string" ? { output: row.output } : {}),
          status,
        }),
      );
      continue;
    }
    if (kind === "terminal") {
      const summary = typeof row.summary === "string" ? row.summary : "";
      if (!summary) continue;
      const cancelled = row.status === "cancelled";
      const failed = row.status === "error";
      const text = `${cancelled ? "Cancelled: " : failed ? "Error: " : ""}${summary}`;
      out.push({
        id: `att_trace_terminal_${ordinal}`,
        role: "assistant",
        content: text,
        createdAt,
        status: failed ? "error" : "done",
        ...(text ? { parts: [{ type: "text", text }] } : {}),
      });
      continue;
    }
    if (kind === "truncated") {
      out.push({
        id: `att_trace_truncated_${ordinal}`,
        role: "system",
        content: "Trace reached its 2 MiB retention limit; later events were not stored.",
        createdAt,
        status: "done",
      });
    }
  }
  return out;
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
  const traceRows = messages.filter(
    (row): row is Record<string, unknown> => isRecord(row) && row.trace === 1,
  );
  if (traceRows.length === messages.length && traceRows.length > 0) {
    return projectAttemptTraceEvents(traceRows);
  }

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
