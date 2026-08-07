import type {
  WikiObservationEntry,
  WikiObservationKind,
  WikiObservationRole,
} from "../orch/types.js";

/**
 * Display-safe observation records for the Navigator execution stream.
 *
 * Durable transcripts intentionally remain generic JSONL so older runs can be
 * read. This adapter keeps that flexibility at the boundary while ensuring the
 * terminal never renders raw tool arguments or result objects.
 */

export type { WikiObservationEntry, WikiObservationKind } from "../orch/types.js";

const MAX_ASSISTANT_LINES = 6;
const MAX_ASSISTANT_LINE_LENGTH = 260;
const MAX_EVENT_TEXT_LENGTH = 180;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeKind(row: Record<string, unknown>): WikiObservationKind | undefined {
  const kind = stringValue(row.kind);
  const role = stringValue(row.role);
  if (kind === "text" || kind === "assistant" || role === "assistant") return "text";
  if (kind === "tool_start" || kind === "tool_execution_start") return "tool_start";
  if (kind === "tool_end" || kind === "tool_execution_end") return "tool_end";
  if (kind === "structured_output") return "structured_output";
  if (kind === "retry_start" || kind === "auto_retry_start") return "retry_start";
  if (kind === "retry_end" || kind === "auto_retry_end") return "retry_end";
  if (kind === "compaction_start") return "compaction_start";
  if (kind === "compaction_end") return "compaction_end";
  if (kind === "summarization_retry") return "summarization_retry";
  return undefined;
}

function roleFor(kind: WikiObservationKind, row: Record<string, unknown>): WikiObservationRole {
  const role = stringValue(row.role);
  if (role === "assistant" || role === "tool" || role === "system") return role;
  if (kind === "text") return "assistant";
  if (kind === "tool_start" || kind === "tool_end" || kind === "structured_output") return "tool";
  return "system";
}

/** Convert current and legacy transcript JSONL entries into a display DTO. */
export function toWikiObservationEntries(entries: readonly unknown[]): WikiObservationEntry[] {
  return entries.map((entry): WikiObservationEntry => {
    if (!entry || typeof entry !== "object") {
      return { role: "system", kind: "text", timestamp: 0, text: String(entry ?? "") };
    }
    const row = entry as Record<string, unknown>;
    const kind = normalizeKind(row);
    const fallbackText = stringValue(row.text) ?? stringValue(row.message) ?? stringValue(row.error);
    if (!kind) {
      return {
        role: "system",
        kind: "text",
        timestamp: numberValue(row.timestamp) ?? 0,
        text: fallbackText ?? "(legacy observation)",
      };
    }
    return {
      kind,
      role: roleFor(kind, row),
      timestamp: numberValue(row.timestamp) ?? 0,
      toolCallId: stringValue(row.toolCallId),
      toolName: stringValue(row.toolName),
      path: stringValue(row.path) ?? stringValue(row.file_path),
      query: stringValue(row.query),
      text: kind === "text" ? fallbackText : undefined,
      error: stringValue(row.error),
      isError: boolValue(row.isError),
      success: boolValue(row.success),
      attempt: numberValue(row.attempt),
      maxAttempts: numberValue(row.maxAttempts),
      delayMs: numberValue(row.delayMs),
      reason: (() => {
        const reason = stringValue(row.reason);
        return reason === "manual" || reason === "threshold" || reason === "overflow" ? reason : undefined;
      })(),
      tokensBefore: numberValue(row.tokensBefore) ?? numberValue(row.beforeTokens),
      tokensAfter: numberValue(row.tokensAfter) ?? numberValue(row.afterTokens),
    };
  });
}

function compactText(value: string | undefined, max: number = MAX_EVENT_TEXT_LENGTH): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function safeSystemNote(value: string | undefined): string {
  const note = compactText(value);
  return note.startsWith("{") || note.startsWith("[") ? "(legacy observation)" : note;
}

function formatTokenCount(tokens: number | undefined): string {
  if (tokens === undefined || tokens < 0) return "?";
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}m`;
}

function toolTarget(entry: WikiObservationEntry): string {
  const path = compactText(entry.path, 120);
  if (path) return `  ${path}`;
  const query = compactText(entry.query, 100);
  return query ? `  ${JSON.stringify(query)}` : "";
}

function formatAssistant(entry: WikiObservationEntry): string[] {
  const source = entry.text?.replace(/\r/g, "") ?? "";
  if (!source.trim()) return [];
  const sourceLines = source
    .split("\n")
    .map((line) => compactText(line, MAX_ASSISTANT_LINE_LENGTH))
    .filter(Boolean);
  const visible = sourceLines.slice(0, MAX_ASSISTANT_LINES);
  const lines = visible.map((line, index) => `${index === 0 ? "assistant" : "         "}  ${line}`);
  if (sourceLines.length > visible.length) lines.push("         …");
  return lines;
}

function formatRetry(entry: WikiObservationEntry): string[] {
  const suffix = entry.attempt !== undefined ? ` ${entry.attempt}/${entry.maxAttempts ?? "?"}` : "";
  const detail = compactText(entry.error ?? entry.reason);
  if (entry.kind === "retry_end" && entry.success === false) return [`! Retry exhausted${suffix}${detail ? ` · ${detail}` : ""}`];
  if (entry.kind === "retry_end" && entry.success) return [`✓ Retry recovered${suffix}`];
  const delay = entry.delayMs !== undefined ? ` · waiting ${Math.max(0, entry.delayMs) / 1_000}s` : "";
  return [`↻ Retry${suffix}${delay}${detail ? ` · ${detail}` : ""}`];
}

function formatCompaction(entry: WikiObservationEntry): string[] {
  const detail = compactText(entry.error ?? entry.reason);
  if (entry.aborted || entry.isError) return [`! Context compaction failed${detail ? ` · ${detail}` : ""}`];
  if (entry.kind === "compaction_end" || entry.tokensAfter !== undefined) {
    const before = formatTokenCount(entry.tokensBefore);
    const after = formatTokenCount(entry.tokensAfter);
    return [`✓ Context compacted${before === "?" && after === "?" ? "" : ` · ${before} → ${after}`}`];
  }
  return [`⌁ Compacting context${detail ? ` · ${detail}` : ""}`];
}

/**
 * Produce terminal lines from semantic records. Tool success completions are
 * deliberately suppressed: the corresponding action line already says what
 * happened, while errors remain visible.
 */
export function formatWikiObservationEntries(entries: readonly WikiObservationEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "text":
        if (entry.role === "assistant") lines.push(...formatAssistant(entry));
        else {
          const note = safeSystemNote(entry.text ?? entry.error);
          if (note) lines.push(note);
        }
        break;
      case "tool_start":
        // structured_output is represented by its own outcome event, not an
        // implementation-level tool invocation plus a duplicate outcome.
        if (entry.toolName !== "structured_output") lines.push(`→ ${entry.toolName ?? "tool"}${toolTarget(entry)}`);
        break;
      case "tool_end": {
        if (!entry.isError) break;
        const error = compactText(entry.error) || "tool failed";
        lines.push(`! ${entry.toolName ?? "tool"}${toolTarget(entry)} · ${error}`);
        break;
      }
      case "structured_output":
        lines.push("✓ Submitted structured result");
        break;
      case "retry_start":
      case "retry_end":
        lines.push(...formatRetry(entry));
        break;
      case "compaction_start":
      case "compaction_end":
        lines.push(...formatCompaction(entry));
        break;
      case "summarization_retry": {
        const detail = compactText(entry.error ?? entry.reason);
        lines.push(`↻ Compaction retry${detail ? ` · ${detail}` : ""}`);
        break;
      }
    }
  }
  return lines;
}
