/**
 * Project canonical Attempt trace events into AgentMessage[] for Node details.
 *
 * Transcripts are a single current wire protocol. The server validates each
 * persisted page; this projection defensively ignores malformed SSE payloads.
 */

import {
  type AgentMessage,
  type AgentToolCall,
  type AgentToolCallStatus,
  type WikiRunAttemptTranscriptDoneFrame,
  WikiRunAttemptTranscriptDoneFrameSchema,
  type WikiRunAttemptTranscriptErrorFrame,
  WikiRunAttemptTranscriptErrorFrameSchema,
  type WikiRunAttemptTranscriptTraceFrame,
  WikiRunAttemptTranscriptTraceFrameSchema,
} from "@okf-wiki/contract";

type TraceRow = Record<string, unknown> & { trace: 1; ordinal: number; at: string; kind: string };

function parseFrame<T>(
  raw: string,
  parser: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): T | undefined {
  try {
    const result = parser.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function parseAttemptTranscriptTraceFrame(
  raw: string,
): WikiRunAttemptTranscriptTraceFrame | undefined {
  return parseFrame(raw, WikiRunAttemptTranscriptTraceFrameSchema);
}

export function parseAttemptTranscriptDoneFrame(
  raw: string,
): WikiRunAttemptTranscriptDoneFrame | undefined {
  return parseFrame(raw, WikiRunAttemptTranscriptDoneFrameSchema);
}

export function parseAttemptTranscriptErrorFrame(
  raw: string,
): WikiRunAttemptTranscriptErrorFrame | undefined {
  return parseFrame(raw, WikiRunAttemptTranscriptErrorFrameSchema);
}

function isTraceRow(value: unknown): value is TraceRow {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { trace?: unknown }).trace === 1 &&
    typeof (value as { ordinal?: unknown }).ordinal === "number" &&
    typeof (value as { at?: unknown }).at === "string" &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

function mapToolStatus(raw: unknown): AgentToolCallStatus {
  return raw === "error" ? "error" : raw === "running" ? "running" : "done";
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

function projectTraceRows(rows: TraceRow[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  const toolIndexesByKey = new Map<string, number[]>();

  for (const row of rows) {
    const { ordinal, at, kind } = row;
    if (kind === "input" && typeof row.content === "string") {
      out.push({
        id: `att_trace_input_${ordinal}`,
        role: "user",
        content: row.content,
        createdAt: at,
        status: "done",
      });
      continue;
    }
    if (kind === "assistant" && typeof row.content === "string") {
      out.push({
        id: `att_trace_assistant_${ordinal}`,
        role: "assistant",
        content: row.content,
        createdAt: at,
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
      out.push(traceToolMessage(ordinal, at, tool));
      continue;
    }
    if (kind === "tool_result" && typeof row.name === "string") {
      const key =
        typeof row.toolCallId === "string" && row.toolCallId.trim()
          ? row.toolCallId
          : `name:${row.name}`;
      const indexes = toolIndexesByKey.get(key);
      const index = indexes?.shift();
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
                status: mapToolStatus(row.status),
              },
            ],
          };
          if (!indexes || indexes.length === 0) toolIndexesByKey.delete(key);
          continue;
        }
      }
      out.push(
        traceToolMessage(ordinal, at, {
          id: `att_trace_tool_${ordinal}`,
          name: row.name,
          ...(typeof row.output === "string" ? { output: row.output } : {}),
          status: mapToolStatus(row.status),
        }),
      );
      continue;
    }
    if (kind === "terminal" && typeof row.summary === "string" && row.summary) {
      const prefix =
        row.status === "cancelled" ? "Cancelled: " : row.status === "error" ? "Error: " : "";
      const content = `${prefix}${row.summary}`;
      out.push({
        id: `att_trace_terminal_${ordinal}`,
        role: "assistant",
        content,
        createdAt: at,
        status: row.status === "error" ? "error" : "done",
        parts: [{ type: "text", text: content }],
      });
      continue;
    }
    if (kind === "truncated") {
      out.push({
        id: `att_trace_truncated_${ordinal}`,
        role: "system",
        content: "Trace reached its 2 MiB retention limit; later events were not stored.",
        createdAt: at,
        status: "done",
      });
    }
  }
  return out;
}

/** Project an already-validated canonical trace page into UI messages. */
export function projectAttemptTranscriptMessages(messages: unknown[]): AgentMessage[] {
  if (!messages.every(isTraceRow)) return [];
  return projectTraceRows(messages);
}

/** Attempt states that open transcript SSE (dialog live stream). */
export function isAttemptTranscriptLive(state: string | null | undefined): boolean {
  return state === "running" || state === "suspended";
}
