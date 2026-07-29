/**
 * Project opaque Attempt transcript messages for Node details UI.
 *
 * Read-only display helper — not Session SSE projection (ADR 0032 / 0035).
 * Messages come from GET …/attempts/:id/transcript (secret-free JSONL rows).
 */

export type ProjectedAttemptTranscriptEntry = {
  /** role+content chat row, compact tool line, or truncated raw JSON. */
  kind: "role" | "tool" | "raw";
  text: string;
  /** Present when kind === "role". */
  role?: string;
};

const RAW_MAX = 240;
const CONTENT_MAX = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Flatten Pi-ish content (string | text parts) to plain text. */
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
      if (typeof part.text === "string") {
        parts.push(part.text);
        continue;
      }
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
  // Bare tool call shape: { name, arguments|args|input } without chat role+content.
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

function toolLine(entry: Record<string, unknown>): string {
  const name =
    (typeof entry.toolName === "string" && entry.toolName.trim()) ||
    (typeof entry.name === "string" && entry.name.trim()) ||
    (typeof entry.type === "string" && entry.type.trim()) ||
    "tool";
  const status = typeof entry.status === "string" ? entry.status.trim() : "";
  const args = entry.arguments ?? entry.args ?? entry.input ?? entry.argsSummary;
  const chunks = [name];
  if (status) chunks.push(status);
  if (args != null && args !== "") {
    try {
      const raw = typeof args === "string" ? args : JSON.stringify(args);
      if (raw && raw !== "{}" && raw !== "null") {
        chunks.push(truncate(raw.replace(/\s+/g, " ").trim(), 96));
      }
    } catch {
      // ignore unserializable args
    }
  }
  return chunks.join(" · ");
}

function rawLine(value: unknown): string {
  try {
    return truncate(JSON.stringify(value), RAW_MAX);
  } catch {
    return truncate(String(value), RAW_MAX);
  }
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
    (typeof row.summary === "string" || typeof row.error === "string" || typeof row.mode === "string")
  );
}

/**
 * Map opaque transcript rows to a stable, UI-ready list.
 * Used by NodeAttemptDialog (and unit-tested in isolation).
 *
 * Recognises:
 * - Pi-ish `{ role, content }`
 * - AttemptItem `{ type: "text" | "toolCall", … }`
 * - legacy metadata stubs with `summary` (schema:1)
 */
export function projectAttemptTranscriptMessages(
  messages: unknown[],
): ProjectedAttemptTranscriptEntry[] {
  const out: ProjectedAttemptTranscriptEntry[] = [];
  for (const row of messages) {
    if (!isRecord(row)) {
      out.push({ kind: "raw", text: rawLine(row) });
      continue;
    }

    // AttemptItem text row from attempt-transcript-sink.
    if (row.type === "text" && typeof row.text === "string") {
      const text = truncate(row.text, CONTENT_MAX);
      out.push({ kind: "role", role: "assistant", text: text || "(empty)" });
      continue;
    }

    // AttemptItem toolCall row.
    if (row.type === "toolCall" && typeof row.name === "string") {
      out.push({ kind: "tool", text: toolLine(row) });
      continue;
    }

    // Pi-ish chat: role + content wins over looser tool heuristics.
    if (typeof row.role === "string" && "content" in row && !isToolish(row)) {
      const text = truncate(contentToText(row.content), CONTENT_MAX);
      out.push({
        kind: "role",
        role: row.role,
        text: text || "(empty)",
      });
      continue;
    }

    if (isToolish(row)) {
      out.push({ kind: "tool", text: toolLine(row) });
      continue;
    }

    // role+content that is also tool-ish (e.g. toolResult with content): prefer role view
    // when content is present so operators still see the result body.
    if (typeof row.role === "string" && "content" in row) {
      const text = truncate(contentToText(row.content), CONTENT_MAX);
      out.push({
        kind: "role",
        role: row.role,
        text: text || toolLine(row),
      });
      continue;
    }

    // Old metadata-only session.jsonl stubs → readable assistant summary.
    if (isLegacyMetadataStub(row)) {
      const summary =
        (typeof row.summary === "string" && row.summary.trim()) ||
        (typeof row.error === "string" && row.error.trim()) ||
        "";
      if (summary) {
        out.push({
          kind: "role",
          role: "assistant",
          text: truncate(summary, CONTENT_MAX),
        });
        continue;
      }
    }

    out.push({ kind: "raw", text: rawLine(row) });
  }
  return out;
}

/** Attempt states that should keep polling the transcript endpoint. */
export function isAttemptTranscriptLive(state: string | null | undefined): boolean {
  return state === "running" || state === "suspended";
}

/** Poll interval for in-flight Attempt transcripts (1.5–2s band). */
export const ATTEMPT_TRANSCRIPT_POLL_MS = 1_750;
