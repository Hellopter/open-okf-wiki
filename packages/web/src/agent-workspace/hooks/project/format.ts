/**
 * String / message extractors for projection surfaces.
 *
 * Message/tool extractors that belong on the shared wire path live in
 * `@okf-wiki/contract` and are re-exported here only when local callers need them.
 */

export {
  formatToolResultText,
  isRecord,
  makeId,
  toolOutputFromResult,
} from "@okf-wiki/contract";

import { PAYLOAD_TEXT_MAX } from "@okf-wiki/contract";

export function nowIso(): string {
  return new Date().toISOString();
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
