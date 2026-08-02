import type {
  ToolDetailLine,
  ToolFileChange,
  ToolItemField,
  ToolItemKind,
  ToolItemStatus,
} from "./types.ts";

const PATH_KEYS = ["path", "file", "filepath", "target", "target_file", "file_path"] as const;
const PATTERN_KEYS = ["pattern", "query", "q"] as const;
const COMMAND_KEYS = ["command", "cmd"] as const;
const CONTENT_KEYS = ["content", "new_string", "newString", "text", "body"] as const;
const OLD_CONTENT_KEYS = ["old_string", "oldString", "old_text"] as const;

const CHIP_MAX = 80;
const SHORT_STRING_MAX = 120;
const DETAIL_LINE_MAX = 160;
const OUTPUT_PREVIEW_LINES = 4;
const OUTPUT_PREVIEW_CHARS = 280;

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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function firstShortStringField(obj: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(obj)) {
    if (key === "runId" || key === "run_id") continue;
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      if (
        trimmed.length <= SHORT_STRING_MAX &&
        !trimmed.startsWith("{") &&
        !trimmed.startsWith("[")
      ) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export type ToolChip = {
  text: string;
  mono: boolean;
};

/**
 * Build the pill content for a tool row.
 * Priority: path → command → pattern → goal → details.summary → first short string.
 */
export function extractToolChip(
  args: unknown,
  details?: { summary?: string } | null,
): ToolChip | undefined {
  const obj = parseToolArgs(args);

  if (obj) {
    const path = stringField(obj, PATH_KEYS);
    if (path) return { text: truncate(path, CHIP_MAX), mono: true };

    const command = stringField(obj, COMMAND_KEYS);
    if (command) return { text: truncate(command, CHIP_MAX), mono: true };

    const pattern = stringField(obj, PATTERN_KEYS);
    if (pattern) return { text: truncate(pattern, CHIP_MAX), mono: true };

    const goal = typeof obj.goal === "string" ? obj.goal.trim() : "";
    if (goal) return { text: truncate(goal, CHIP_MAX), mono: false };

    const short = firstShortStringField(obj);
    if (short) return { text: truncate(short, CHIP_MAX), mono: false };
  }

  const summary = details?.summary?.trim();
  if (summary) return { text: truncate(summary, CHIP_MAX), mono: false };

  return undefined;
}

/**
 * Compact primary fields used while composing detail lines (not UI chrome).
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

  for (const key of PATH_KEYS) {
    if (key in obj) push(key, obj[key]);
  }
  for (const key of PATTERN_KEYS) {
    if (key in obj) push(key, obj[key]);
  }
  for (const key of COMMAND_KEYS) {
    if (key in obj) push(key, obj[key]);
  }
  if ("goal" in obj) push("goal", obj.goal);
  if ("runId" in obj) push("runId", obj.runId);
  if ("run_id" in obj) push("runId", obj.run_id);
  if ("nodeKey" in obj) push("nodeKey", obj.nodeKey);

  for (const [key, value] of Object.entries(obj)) {
    if (fields.length >= 4) break;
    if (seen.has(key)) continue;
    if (typeof value === "string" && value.trim() && value.trim().length <= SHORT_STRING_MAX) {
      push(key, value);
    }
  }

  return fields.length > 0 ? fields : undefined;
}

function previewText(text: string): string {
  const lines = text.split("\n");
  const head = lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n").trim();
  return truncate(head, OUTPUT_PREVIEW_CHARS);
}

export type DetailLineOptions = {
  status: ToolItemStatus;
  summary?: string;
  output?: string;
  errorText?: string;
  /** Chip already shows this text — skip duplicate detail lines. */
  chipText?: string;
};

/**
 * Left-rail detail lines for expanded tool rows.
 * Prefer scannable short lines over raw JSON dumps.
 */
export function extractToolDetailLines(
  args: unknown,
  details: { summary?: string } | null | undefined,
  opts: DetailLineOptions,
): ToolDetailLine[] | undefined {
  const lines: ToolDetailLine[] = [];
  const seen = new Set<string>();
  const chip = opts.chipText?.trim();

  const push = (line: ToolDetailLine) => {
    const key = line.text.trim();
    if (!key || seen.has(key)) return;
    if (chip && key === chip) return;
    seen.add(key);
    lines.push({
      ...line,
      text: truncate(line.text.trim(), DETAIL_LINE_MAX),
    });
  };

  if (opts.errorText?.trim()) {
    push({ text: opts.errorText.trim(), tone: "error", mono: true });
  }

  const summary = (opts.summary ?? details?.summary)?.trim();
  if (summary && summary !== opts.errorText?.trim()) {
    push({ text: summary, tone: "default" });
  }

  const fields = extractPrimaryFields(args) ?? [];
  for (const field of fields) {
    if (chip && field.value === chip) continue;
    const mono =
      (PATH_KEYS as readonly string[]).includes(field.label) ||
      (COMMAND_KEYS as readonly string[]).includes(field.label) ||
      field.label === "runId" ||
      field.label === "nodeKey";
    push({
      text: `${field.label}: ${field.value}`,
      mono,
      tone: "default",
    });
  }

  if (opts.status !== "error" && opts.output?.trim()) {
    const preview = previewText(opts.output);
    if (preview && preview !== summary && preview !== opts.errorText?.trim()) {
      const looksOk = /^[✓✔]|\bok\b|passed|accepted|done/i.test(preview);
      push({
        text: preview,
        mono: true,
        tone: looksOk ? "ok" : "default",
      });
    }
  }

  return lines.length > 0 ? lines : undefined;
}

/** Pretty-print raw args for secondary expand when detail lines are insufficient. */
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

function fileLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").filter(Boolean).pop();
  return base && base.length > 0 ? base : path;
}

function countLines(text: string): number {
  if (!text) return 0;
  // Trailing newline does not add an extra empty line for our purposes.
  return text.replace(/\n$/, "").split("\n").length;
}

/** Count +/- lines in a unified diff, ignoring headers. */
export function countUnifiedDiffStats(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of text.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
}

function pathFromDiffHeader(text: string): string | undefined {
  for (const line of text.split("\n")) {
    // +++ b/path/to/file.tsx
    const plus = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (plus?.[1] && plus[1] !== "/dev/null") {
      return plus[1].trim().replace(/^\.\//, "");
    }
  }
  for (const line of text.split("\n")) {
    const minus = line.match(/^---\s+(?:a\/)?(.+)$/);
    if (minus?.[1] && minus[1] !== "/dev/null") {
      return minus[1].trim().replace(/^\.\//, "");
    }
  }
  return undefined;
}

function looksLikeUnifiedDiff(text: string): boolean {
  return (
    /^diff --git /m.test(text) ||
    /^@@\s+-\d/m.test(text) ||
    (/^\+\+\+\s/m.test(text) && /^---\s/m.test(text))
  );
}

/**
 * Derive a file-change chip from tool args/output.
 * Prefers unified-diff stats; falls back to write/edit arg content line counts.
 */
export function extractFileChange(
  args: unknown,
  output: string | undefined,
  kind: ToolItemKind,
): ToolFileChange | undefined {
  const obj = parseToolArgs(args);
  const pathFromArgs = obj ? stringField(obj, PATH_KEYS) : undefined;

  if (output && looksLikeUnifiedDiff(output)) {
    const stats = countUnifiedDiffStats(output);
    if (stats.add === 0 && stats.del === 0) return undefined;
    const path = pathFromArgs ?? pathFromDiffHeader(output);
    if (!path) return undefined;
    return { file: fileLabel(path), add: stats.add, del: stats.del };
  }

  // Only invent stats for write/edit tools — never for read/search.
  if (kind !== "write") return undefined;
  if (!obj || !pathFromArgs) return undefined;

  const newContent = stringField(obj, CONTENT_KEYS);
  const oldContent = stringField(obj, OLD_CONTENT_KEYS);

  if (newContent !== undefined && oldContent !== undefined) {
    // search_replace style: approximate with line counts of old/new snippets.
    return {
      file: fileLabel(pathFromArgs),
      add: countLines(newContent),
      del: countLines(oldContent),
    };
  }

  if (newContent !== undefined) {
    return {
      file: fileLabel(pathFromArgs),
      add: countLines(newContent),
      del: 0,
    };
  }

  // Output hints: "Wrote 42 lines", "+12 -3"
  if (output) {
    const wrote = output.match(/\b(?:wrote|writing)\s+(\d+)\s+lines?\b/i);
    if (wrote) {
      return { file: fileLabel(pathFromArgs), add: Number(wrote[1]), del: 0 };
    }
    const plusMinus = output.match(/\+(\d+)\s+[−\-–](\d+)/);
    if (plusMinus) {
      return {
        file: fileLabel(pathFromArgs),
        add: Number(plusMinus[1]),
        del: Number(plusMinus[2]),
      };
    }
  }

  return undefined;
}

/** Merge per-tool file changes into unique file chips (sum add/del). */
export function aggregateFileChanges(items: readonly { fileChange?: ToolFileChange }[]): ToolFileChange[] {
  const map = new Map<string, ToolFileChange>();
  for (const item of items) {
    const change = item.fileChange;
    if (!change) continue;
    const key = change.file;
    const prev = map.get(key);
    if (prev) {
      map.set(key, {
        file: key,
        add: prev.add + change.add,
        del: prev.del + change.del,
      });
    } else {
      map.set(key, { file: change.file, add: change.add, del: change.del });
    }
  }
  return [...map.values()];
}
