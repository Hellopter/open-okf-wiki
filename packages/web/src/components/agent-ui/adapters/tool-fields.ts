import type { ToolItemField, ToolItemStatus } from "./types.ts";

const PATH_KEYS = ["path", "file", "filepath", "target", "target_file", "file_path"] as const;
const PATTERN_KEYS = ["pattern", "query", "q"] as const;
const SHORT_STRING_MAX = 120;

/** Parse tool args that may arrive as an object or JSON string. */
export function parseToolArgs(args: unknown): Record<string, unknown> | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return undefined;
}

function stringField(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstShortStringField(obj: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (key === "runId" || key === "run_id") continue;
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      if (trimmed.length <= SHORT_STRING_MAX && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/**
 * Build a one-line subtitle under the tool title.
 * Priority: details.summary → path → pattern → first short string field.
 */
export function extractToolHeadline(
  args: unknown,
  details?: { summary?: string } | null,
): string | undefined {
  const summary = details?.summary?.trim();
  if (summary) return summary;

  const obj = parseToolArgs(args);
  if (!obj) return undefined;

  const path = stringField(obj, PATH_KEYS);
  if (path) return path;

  const pattern = stringField(obj, PATTERN_KEYS);
  if (pattern) return pattern;

  return firstShortStringField(obj);
}

/**
 * Compact primary fields for expanded view (not full JSON dumps).
 * Prefer a few high-signal keys over dumping everything.
 */
export function extractPrimaryFields(args: unknown): ToolItemField[] | undefined {
  const obj = parseToolArgs(args);
  if (!obj) return undefined;

  const fields: ToolItemField[] = [];
  const seen = new Set<string>();

  const push = (label: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || seen.has(label)) return;
      seen.add(label);
      fields.push({ label, value: trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed });
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      if (seen.has(label)) return;
      seen.add(label);
      fields.push({ label, value: String(value) });
    }
  };

  // Prefer known keys in a stable order.
  for (const key of PATH_KEYS) {
    if (key in obj) push(key, obj[key]);
  }
  for (const key of PATTERN_KEYS) {
    if (key in obj) push(key, obj[key]);
  }
  if ("goal" in obj) push("goal", obj.goal);
  if ("runId" in obj) push("runId", obj.runId);
  if ("run_id" in obj) push("runId", obj.run_id);
  if ("nodeKey" in obj) push("nodeKey", obj.nodeKey);
  if ("command" in obj) push("command", obj.command);

  // Fill remaining short string fields up to a small cap.
  for (const [key, value] of Object.entries(obj)) {
    if (fields.length >= 4) break;
    if (seen.has(key)) continue;
    if (typeof value === "string" && value.trim() && value.trim().length <= SHORT_STRING_MAX) {
      push(key, value);
    }
  }

  return fields.length > 0 ? fields : undefined;
}

/** Pretty-print raw args for secondary "Raw input" section. */
export function formatRawArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/**
 * defaultOpen is true only for in-flight or error tools —
 * NOT merely because args/output exist.
 */
export function toolDefaultOpen(status: ToolItemStatus): boolean {
  return status === "pending" || status === "running" || status === "error";
}
