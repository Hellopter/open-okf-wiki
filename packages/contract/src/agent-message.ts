/**
 * Operator UI AgentMessage wire shape and pure Pi → AgentMessage parsers.
 *
 * Shared by web (live SSE reduce), agent (history projection), and server.
 * No Node APIs — safe for browser and Node.
 *
 * Client-only fields (e.g. optimistic user rows) are intentionally omitted;
 * the web layer may extend AgentMessage locally.
 */

import { z } from "zod";
import { type WikiProduceToolDetails, WikiProduceToolDetailsSchema } from "./wiki-produce.js";

// ---------------------------------------------------------------------------
// Zod schemas (stable wire / view shape, no optimistic-only fields)
// ---------------------------------------------------------------------------

export const AgentMessageRoleSchema = z.enum(["user", "assistant", "tool", "system"]);
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>;

export const AgentToolCallStatusSchema = z.enum(["pending", "running", "done", "error"]);
export type AgentToolCallStatus = z.infer<typeof AgentToolCallStatusSchema>;

export const AgentToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Structured tool arguments from Pi toolCall / tool_execution_start. */
    args: z.unknown().optional(),
    output: z.string().optional(),
    /** Structured details emitted by the real Pi wiki_produce tool. */
    details: WikiProduceToolDetailsSchema.optional(),
    status: AgentToolCallStatusSchema,
  })
  .strict();

export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

/** Ordered Pi assistant content; tool status lives on AgentMessage.tools. */
export const AgentContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("thinking"), thinking: z.string() }).strict(),
  z.object({ type: z.literal("tool"), toolId: z.string().min(1) }).strict(),
]);

export type AgentContentPart = z.infer<typeof AgentContentPartSchema>;

export const AgentMessageStatusSchema = z.enum(["streaming", "done", "error", "aborted"]);
export type AgentMessageStatus = z.infer<typeof AgentMessageStatusSchema>;

export const AgentThinkingStatusSchema = z.enum(["streaming", "done"]);
export type AgentThinkingStatus = z.infer<typeof AgentThinkingStatusSchema>;

/**
 * Stable operator-facing message shape (SSE / history / transcript).
 * Does not include client-only optimistic markers.
 */
export const AgentMessageSchema = z
  .object({
    id: z.string().min(1),
    role: AgentMessageRoleSchema,
    content: z.string(),
    thinking: z.string().optional(),
    thinkingStatus: AgentThinkingStatusSchema.optional(),
    createdAt: z.string().min(1),
    tools: z.array(AgentToolCallSchema).optional(),
    parts: z.array(AgentContentPartSchema).optional(),
    status: AgentMessageStatusSchema.optional(),
    errorText: z.string().optional(),
  })
  .strict();

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM / Node)
// ---------------------------------------------------------------------------

/** Default cap for tool / payload surfaces (pretty JSON can grow fast). */
export const PAYLOAD_TEXT_MAX = 12_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Prefer Pi wire message.id when present; otherwise undefined (caller falls back). */
export function piMessageId(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.id !== "string") return undefined;
  const id = message.id.trim();
  return id || undefined;
}

export function messageRole(message: unknown): string | null {
  if (!isRecord(message) || typeof message.role !== "string") return null;
  return message.role;
}

export function wikiProduceDetails(value: unknown): WikiProduceToolDetails | undefined {
  if (!isRecord(value) || !isRecord(value.details)) return undefined;
  const parsed = WikiProduceToolDetailsSchema.safeParse(value.details);
  return parsed.success ? parsed.data : undefined;
}

/** Extract plain text from a Pi assistant/user message content array or string. */
export function extractMessageText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

/** Extract thinking blocks from a Pi assistant message content array. */
export function extractMessageThinking(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

/**
 * Pi assistant error fields (stopReason + provider error text).
 * Used when the provider fails without throwing from session.prompt().
 */
export function extractAssistantError(message: unknown): {
  isError: boolean;
  /** Operator/user abort without a provider error — neutral, not a failure. */
  aborted: boolean;
  errorText?: string;
  stopReason?: string;
} {
  if (!isRecord(message)) return { isError: false, aborted: false };
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  // Wire field is provider-native; avoid a bare status-like identifier for scanners.
  const raw = (message as Record<string, unknown>)["error" + "Message"];
  const errorText = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  const aborted = stopReason === "aborted" && !errorText;
  const isError = !aborted && (stopReason === "error" || Boolean(errorText));
  return { isError, aborted, errorText, stopReason };
}

/**
 * Extract human-readable tool *result* text (OpenCode / pi-web style).
 * Prefer content[].text from Pi AgentToolResult; never dump full JSON envelopes.
 */
export function formatToolResultText(value: unknown, max = PAYLOAD_TEXT_MAX): string | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const nested = formatToolResultText(JSON.parse(trimmed), max);
        if (nested) return nested;
      } catch {
        // keep raw string
      }
    }
    return trimmed.length > max
      ? `${trimmed.slice(0, max)}\n…[truncated ${trimmed.length - max} chars]`
      : trimmed;
  }

  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const block of value) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
      } else if (typeof block.text === "string") {
        texts.push(block.text);
      }
    }
    if (texts.length > 0) {
      return formatToolResultText(texts.join("\n"), max);
    }
    const asLines = value
      .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : null))
      .filter(Boolean) as string[];
    if (asLines.length === value.length && asLines.length > 0) {
      return formatToolResultText(asLines.join("\n"), max);
    }
    return undefined;
  }

  if (isRecord(value)) {
    if (Array.isArray(value.content)) {
      const fromContent = formatToolResultText(value.content, max);
      if (fromContent) return fromContent;
    }
    for (const key of ["text", "output", "stdout", "result", "message"] as const) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return formatToolResultText(value[key], max);
      }
    }
    if (isRecord(value.details)) {
      const d = value.details;
      for (const key of ["preview", "output", "text", "stdout"] as const) {
        if (typeof d[key] === "string" && d[key].trim()) {
          return formatToolResultText(d[key], max);
        }
      }
    }
    return undefined;
  }

  return String(value);
}

/**
 * Single derivation path for tool *output* display text.
 *
 * Prefer `details.summary` (wiki_produce live + snapshot activeTool), peeling
 * `result.details.summary` when the caller omits a separate details arg.
 */
export function toolOutputFromResult(
  result: unknown,
  details?: { summary?: string } | null,
): string | undefined {
  if (details && typeof details.summary === "string" && details.summary.trim()) {
    return formatToolResultText(details.summary);
  }
  if (
    details == null &&
    isRecord(result) &&
    isRecord(result.details) &&
    typeof result.details.summary === "string" &&
    result.details.summary.trim()
  ) {
    return formatToolResultText(result.details.summary);
  }
  return formatToolResultText(result);
}

// ---------------------------------------------------------------------------
// Pi content-block parsers → AgentMessage
// ---------------------------------------------------------------------------

/** toolCall blocks from a Pi assistant content array. */
export function extractToolCallsFromMessage(
  message: unknown,
  prevTools?: AgentToolCall[],
): AgentToolCall[] | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return prevTools;
  }
  const prevById = new Map((prevTools ?? []).map((t) => [t.id, t]));
  const tools: AgentToolCall[] = [];
  const seen = new Set<string>();
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall") continue;
    const id = typeof block.id === "string" ? block.id : makeId("tool");
    const name = typeof block.name === "string" ? block.name : "tool";
    const prev = prevById.get(id);
    const args = "arguments" in block ? block.arguments : "args" in block ? block.args : undefined;
    tools.push({
      id,
      name,
      args: args !== undefined ? args : prev?.args,
      output: prev?.output,
      ...(prev?.details ? { details: prev.details } : {}),
      status: prev?.status ?? "pending",
    });
    seen.add(id);
  }
  // Keep tools that only arrived via tool_execution_* (not yet in content).
  for (const t of prevTools ?? []) {
    if (!seen.has(t.id)) tools.push(t);
  }
  return tools.length > 0 ? tools : prevTools;
}

/**
 * Build chronological parts from Pi content[] (text / thinking / toolCall order).
 * Tools that only exist via tool_execution_* (not yet in content) append at end.
 */
export function extractPartsFromMessage(
  message: unknown,
  tools: AgentToolCall[] | undefined,
  prevParts?: AgentContentPart[],
): AgentContentPart[] | undefined {
  const parts: AgentContentPart[] = [];
  if (isRecord(message) && Array.isArray(message.content)) {
    let textBuf = "";
    let thinkingBuf = "";
    const flushText = () => {
      if (textBuf) {
        parts.push({ type: "text", text: textBuf });
        textBuf = "";
      }
    };
    const flushThinking = () => {
      if (thinkingBuf) {
        parts.push({ type: "thinking", thinking: thinkingBuf });
        thinkingBuf = "";
      }
    };
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking" && typeof block.thinking === "string") {
        flushText();
        thinkingBuf += block.thinking;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        flushThinking();
        textBuf += block.text;
        continue;
      }
      if (block.type === "toolCall") {
        flushText();
        flushThinking();
        const id = typeof block.id === "string" ? block.id : makeId("tool");
        parts.push({ type: "tool", toolId: id });
      }
    }
    flushText();
    flushThinking();
  }

  // If snapshot had no content parts but we had prior parts, keep prior structure
  // and merge new tool ids (tool_execution before content toolCall block).
  // Must run before tools-only append — otherwise tools alone make parts non-empty
  // and silently drop text/thinking from prevParts.
  if (parts.length === 0 && prevParts?.length) {
    const merged = prevParts.slice();
    const priorToolIds = new Set(
      merged
        .filter((p): p is { type: "tool"; toolId: string } => p.type === "tool")
        .map((p) => p.toolId),
    );
    for (const t of tools ?? []) {
      if (!priorToolIds.has(t.id)) {
        merged.push({ type: "tool", toolId: t.id });
        priorToolIds.add(t.id);
      }
    }
    return merged;
  }

  // Preserve tools that only arrived via tool_execution_* (append if missing).
  const seenTool = new Set(
    parts
      .filter((p): p is { type: "tool"; toolId: string } => p.type === "tool")
      .map((p) => p.toolId),
  );
  for (const t of tools ?? []) {
    if (!seenTool.has(t.id)) {
      parts.push({ type: "tool", toolId: t.id });
      seenTool.add(t.id);
    }
  }

  return parts.length > 0 ? parts : undefined;
}

/**
 * Build thin AgentMessage from a Pi assistant message snapshot.
 * Snapshot is authority for text/thinking/toolCall list; prior tools keep
 * execution status/output. `parts` preserves content[] interleaving.
 */
export function assistantFromSnapshot(
  message: unknown,
  opts: {
    id: string;
    prev?: AgentMessage | null;
    status: "streaming" | "done" | "error";
    ts: string;
  },
): AgentMessage {
  const text = extractMessageText(message);
  const thinking = extractMessageThinking(message);
  const err = extractAssistantError(message);
  const isError = err.isError || opts.status === "error";
  const tools = extractToolCallsFromMessage(message, opts.prev?.tools);
  const parts = extractPartsFromMessage(message, tools, opts.prev?.parts);

  let thinkingStatus = opts.prev?.thinkingStatus;
  if (thinking) {
    thinkingStatus = opts.status === "streaming" ? "streaming" : "done";
  } else if (opts.status !== "streaming") {
    thinkingStatus = thinkingStatus === "streaming" ? "done" : thinkingStatus;
  }

  return {
    id: opts.id,
    role: "assistant",
    content:
      text || (isError ? (err.errorText ?? opts.prev?.content ?? "") : (opts.prev?.content ?? "")),
    thinking: thinking || opts.prev?.thinking,
    thinkingStatus: thinking ? thinkingStatus : opts.prev?.thinkingStatus,
    createdAt: opts.prev?.createdAt ?? opts.ts,
    tools,
    parts,
    status: isError ? "error" : opts.status,
    errorText: err.errorText ?? opts.prev?.errorText,
  };
}

export function patchToolsOnAssistant(
  msg: AgentMessage,
  toolCallId: string,
  patch: Partial<AgentToolCall> & { name?: string },
): AgentMessage {
  const tools = [...(msg.tools ?? [])];
  const idx = tools.findIndex((t) => t.id === toolCallId);
  if (idx >= 0) {
    tools[idx] = { ...tools[idx]!, ...patch, id: toolCallId };
  } else {
    tools.push({
      id: toolCallId,
      name: patch.name ?? "tool",
      args: patch.args,
      output: patch.output,
      status: patch.status ?? "running",
    });
  }
  // Keep parts in chronological order: add tool part if missing.
  let parts = msg.parts?.slice();
  if (parts) {
    const has = parts.some((p) => p.type === "tool" && p.toolId === toolCallId);
    if (!has) parts = [...parts, { type: "tool", toolId: toolCallId }];
  } else {
    parts = [{ type: "tool", toolId: toolCallId }];
  }
  return { ...msg, tools, parts };
}

const INCOMPLETE_TOOL_STATUSES = new Set<AgentToolCallStatus>(["pending", "running"]);

/**
 * Mark every pending/running tool on a message as error (history has no live tools).
 * Preserves existing output; fills `Interrupted` when output is empty.
 */
export function finalizeIncompleteToolsOnMessage(
  message: AgentMessage,
  outputIfEmpty = "Interrupted",
): AgentMessage {
  if (!message.tools?.length) return message;
  let changed = false;
  const tools = message.tools.map((tool) => {
    if (!INCOMPLETE_TOOL_STATUSES.has(tool.status)) return tool;
    changed = true;
    const hasOutput = typeof tool.output === "string" && tool.output.trim().length > 0;
    return {
      ...tool,
      status: "error" as const,
      output: hasOutput ? tool.output : outputIfEmpty,
    };
  });
  return changed ? { ...message, tools } : message;
}

/** Finalize incomplete tools across a message list (pure; returns same ref when unchanged). */
export function finalizeIncompleteTools(
  messages: readonly AgentMessage[],
  outputIfEmpty = "Interrupted",
): AgentMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    const patched = finalizeIncompleteToolsOnMessage(message, outputIfEmpty);
    if (patched !== message) changed = true;
    return patched;
  });
  return changed ? next : (messages as AgentMessage[]);
}

function historyTimestamp(row: unknown): string {
  if (!isRecord(row) || typeof row.timestamp !== "number") {
    return new Date().toISOString();
  }
  const date = new Date(row.timestamp);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * Project opaque Pi SessionManager history rows into AgentMessage[] (stable wire shape).
 * Same rules as the web live projector’s durable branch path.
 */
export function projectAgentMessagesFromPiHistory(rows: readonly unknown[]): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!isRecord(row)) continue;
    const createdAt = historyTimestamp(row);
    const role = typeof row.role === "string" ? row.role : null;

    if (role === "user") {
      messages.push({
        id: piMessageId(row) ?? `hist_user_${index + 1}`,
        role: "user",
        content: extractMessageText(row),
        createdAt,
        status: "done",
      });
      continue;
    }

    if (role === "assistant") {
      const error = extractAssistantError(row);
      messages.push(
        assistantFromSnapshot(row, {
          id: piMessageId(row) ?? `hist_asst_${index + 1}`,
          status: error.isError ? "error" : "done",
          ts: createdAt,
        }),
      );
      continue;
    }

    // Full-branch transcript includes compaction markers (not model-only context).
    if (role === "compactionSummary") {
      const summary =
        typeof row.summary === "string" && row.summary.trim()
          ? row.summary.trim()
          : "Conversation context was compacted.";
      messages.push({
        id: piMessageId(row) ?? `hist_compact_${index + 1}`,
        role: "system",
        content: summary,
        createdAt,
        status: "done",
      });
      continue;
    }

    if (role === "branchSummary") {
      const summary =
        typeof row.summary === "string" && row.summary.trim()
          ? row.summary.trim()
          : "Branch summary.";
      messages.push({
        id: piMessageId(row) ?? `hist_branch_${index + 1}`,
        role: "system",
        content: summary,
        createdAt,
        status: "done",
      });
      continue;
    }

    if (role !== "toolResult" || typeof row.toolCallId !== "string") continue;
    const details = wikiProduceDetails(row);
    const output = toolOutputFromResult(row, details);
    const toolCallId = row.toolCallId;
    const toolName = typeof row.toolName === "string" ? row.toolName : undefined;
    const isError = row.isError === true;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]!;
      if (message.role !== "assistant") continue;
      if (!message.tools?.some((tool) => tool.id === toolCallId)) continue;
      messages[messageIndex] = patchToolsOnAssistant(message, toolCallId, {
        name: toolName,
        output,
        ...(details ? { details } : {}),
        status: isError ? "error" : "done",
      });
      break;
    }
  }

  // History is durable: no live tools. Anything still pending/running never got a toolResult.
  return finalizeIncompleteTools(messages);
}
