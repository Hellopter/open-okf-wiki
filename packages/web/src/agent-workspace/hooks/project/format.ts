/**
 * String / message extractors for projection surfaces.
 */

/** Default cap for tool / payload surfaces (pretty JSON can grow fast). */
export const PAYLOAD_TEXT_MAX = 12_000;

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
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
    // If the string is a JSON envelope, peel it once.
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
    // Pi content array: [{type:'text', text:'…'}, …]
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
    // Array of strings / scalars
    const asLines = value
      .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : null))
      .filter(Boolean) as string[];
    if (asLines.length === value.length && asLines.length > 0) {
      return formatToolResultText(asLines.join("\n"), max);
    }
    return undefined;
  }

  if (isRecord(value)) {
    // AgentToolResult: { content: [...], details?, isError? }
    if (Array.isArray(value.content)) {
      const fromContent = formatToolResultText(value.content, max);
      if (fromContent) return fromContent;
    }
    // Common single-field results
    for (const key of ["text", "output", "stdout", "result", "message"] as const) {
      if (typeof value[key] === "string" && value[key].trim()) {
        return formatToolResultText(value[key], max);
      }
    }
    // details.preview / details.output
    if (isRecord(value.details)) {
      const d = value.details;
      for (const key of ["preview", "output", "text", "stdout"] as const) {
        if (typeof d[key] === "string" && d[key].trim()) {
          return formatToolResultText(d[key], max);
        }
      }
    }
    // Don't fall back to full JSON dump — empty means "no displayable result"
    return undefined;
  }

  return String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 *
 * Failures are announced in Transcript (`role="alert"` / `aria-live`).
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
 * Pretty-print complete JSON object/array strings for tool / payload surfaces.
 * Incomplete or non-JSON text is returned as-is. Overlong results are truncated
 * with a clear marker (avoids crushing the layout with multi-MB blobs).
 */
export function formatPayloadText(raw: string | undefined, max = PAYLOAD_TEXT_MAX): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  let out = raw;
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      out = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // keep original (incomplete stream, non-JSON braces, etc.)
    }
  }
  if (max > 0 && out.length > max) {
    const omitted = out.length - max;
    return `${out.slice(0, max)}\n…[truncated ${omitted} chars]`;
  }
  return out;
}
