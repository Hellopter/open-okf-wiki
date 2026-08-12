/**
 * Compact agent session messages into a bounded chronological history.
 * Pure module: no @earendil-works/* imports.
 */

import type { WikiHistoryEntry } from "./producer-types.js";

export type { WikiHistoryEntry };

export interface CompactWikiHistoryOptions {
  maxEntries?: number;
  maxTextChars?: number;
  maxTotalChars?: number;
}

export const DEFAULT_MAX_ENTRIES = 40;
export const DEFAULT_MAX_TEXT_CHARS = 2000;
export const DEFAULT_MAX_TOTAL_CHARS = 20000;

export function compactWikiHistory(messages: unknown[], options: CompactWikiHistoryOptions = {}): WikiHistoryEntry[] {
  if (!Array.isArray(messages)) return [];

  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxTextChars = positiveInt(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
  const maxTotalChars = positiveInt(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const entries: WikiHistoryEntry[] = [];

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;

    if (role === "user") {
      const text = textFromContent(message.content);
      if (text.trim()) entries.push({ role: "user", kind: "text", text, timestamp });
      continue;
    }

    if (role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const block = asRecord(part);
        if (!block || typeof block.type !== "string") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          entries.push({ role: "assistant", kind: "text", text: block.text, timestamp });
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          const args = asRecord(block.arguments);
          const filePath =
            (block.name === "write" || block.name === "edit") && typeof args?.path === "string" ? args.path : undefined;
          const writeContent =
            block.name === "write" && filePath && typeof args?.content === "string" ? args.content : undefined;
          entries.push({
            role: "assistant",
            kind: "toolCall",
            toolName: block.name,
            // A write's JSON envelope is both noisy and likely to be truncated
            // into invalid JSON. Preserve its source directly so callers can
            // render it as code. Edit calls retain their path so the compact
            // call header can be paired with the result text.
            text: writeContent ?? stringifyCompact(block.arguments ?? {}),
            path: filePath,
            timestamp,
          });
        }
      }
      if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
        entries.push({ role: "assistant", kind: "error", text: message.errorMessage, isError: true, timestamp });
      }
      continue;
    }

    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      const baseText = textFromContent(message.content) || "(no text output)";
      const details = asRecord(message.details);
      // Fold edit diffs into text rather than exposing a public `diff` field.
      const diff = toolName === "edit" && typeof details?.diff === "string" ? details.diff : undefined;
      entries.push({
        role: "tool",
        kind: message.isError ? "error" : "toolResult",
        toolName,
        text: diff ? `${baseText}\n${diff}` : baseText,
        isError: Boolean(message.isError),
        timestamp,
      });
    }
  }

  return fitEntries(entries, maxEntries, maxTextChars, maxTotalChars);
}

function fitEntries(
  entries: WikiHistoryEntry[],
  maxEntries: number,
  maxTextChars: number,
  maxTotalChars: number,
): WikiHistoryEntry[] {
  const fitted: WikiHistoryEntry[] = [];
  let total = 0;

  for (const entry of entries.slice(-maxEntries).reverse()) {
    const remaining = maxTotalChars - total;
    if (remaining <= 0) break;

    const text = truncateText(entry.text, Math.min(maxTextChars, remaining));
    fitted.unshift({ ...entry, text });
    total += text.length;
  }

  return fitted;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("");
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 20)}... [truncated]`;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
