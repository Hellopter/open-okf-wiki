/**
 * Pure Pi → AgentMessage content helpers (no stream reduce).
 * Used by the live projector and durable history projection.
 */

import { type WikiProduceToolDetails, WikiProduceToolDetailsSchema } from "@okf-wiki/contract";
import {
  extractAssistantError,
  extractMessageText,
  extractMessageThinking,
  isRecord,
  makeId,
} from "./format.ts";
import type { AgentContentPart, AgentMessage, AgentToolCall } from "./types.ts";

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

  // If snapshot had no content array but we had prior parts, keep prior structure
  // and merge new tool ids (tool_execution before content toolCall block).
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
