import type {
  WikiObservationEntry,
  WikiObservationKind,
} from "../orch/types.js";

/**
 * Display-safe observation records for the Navigator execution stream.
 *
 * Entries are written by the Pi runner and contain only display-safe fields.
 */

export type { WikiObservationEntry, WikiObservationKind } from "../orch/types.js";

const MAX_ASSISTANT_LINES = 6;
const MAX_ASSISTANT_LINE_LENGTH = 260;
const MAX_EVENT_TEXT_LENGTH = 180;

function compactText(value: string | undefined, max: number = MAX_EVENT_TEXT_LENGTH): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function safeSystemNote(value: string | undefined): string {
  const note = compactText(value);
  return note.startsWith("{") || note.startsWith("[") ? "(unrenderable observation)" : note;
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
        lines.push(`→ ${entry.toolName ?? "tool"}${toolTarget(entry)}`);
        break;
      case "tool_end": {
        if (!entry.isError) break;
        const error = compactText(entry.error) || "tool failed";
        lines.push(`! ${entry.toolName ?? "tool"}${toolTarget(entry)} · ${error}`);
        break;
      }
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
