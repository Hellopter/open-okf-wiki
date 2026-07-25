/**
 * Tool display summary — OpenCode BasicTool / pi-web specialized renderer style.
 *
 * One-line header: title + subtitle + optional args chips.
 * Expand body is RESULT only (no "Input" / "Output" labels).
 * Args already shown in the header are never repeated as JSON.
 */

import { formatPayloadText, isRecord } from "../../hooks/project/format.ts";

export type ToolDisplaySummary = {
  /** Verb / tool label shown in the trigger (e.g. "read", "grep"). */
  title: string;
  /** Key target on the same line (filename, pattern, command…). */
  subtitle?: string;
  /** Secondary chips after subtitle (OpenCode args: offset=…, pattern=…). */
  args?: string[];
  /**
   * How to expand:
   * - output-only: only tool result text (read/grep/ls when completed)
   * - write-body: write/edit content preview + result
   * - raw: unknown tools — pretty args only when there is no structured header
   */
  kind: "output-only" | "write-body" | "raw";
  /** For write/edit: content preview in expand (not labeled "Input"). */
  writePreview?: string;
  /** True when this tool is fully described by the header (no expand needed). */
  headerOnly?: boolean;
};

/** Coerce structured or legacy string tool args into a param record. */
export function parseToolInput(args: unknown): Record<string, unknown> | null {
  if (args === undefined || args === null) return null;
  if (isRecord(args)) return args;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON
    }
    return null;
  }
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** Basename-ish label for paths (OpenCode getFilename style). */
export function toolPathLabel(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return pathValue;
  if (parts.length === 1) return parts[0]!;
  return parts[parts.length - 1]!;
}

function truncateOneLine(text: string, max = 72): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * OpenCode-style tool summary.
 * Known tools put everything useful on the trigger line; expand is result-only.
 * Prefers structured `args` objects from Pi (no string round-trip).
 */
export function formatToolDisplay(toolName: string, args?: unknown): ToolDisplaySummary {
  const name = toolName.trim() || "tool";
  const lower = name.toLowerCase();
  const params = parseToolInput(args);

  if (!params) {
    const raw =
      typeof args === "string"
        ? args.trim()
        : args !== undefined && args !== null
          ? (() => {
              try {
                return JSON.stringify(args);
              } catch {
                return String(args);
              }
            })()
          : undefined;
    if (raw && raw.length <= 80 && !raw.startsWith("{") && !raw.startsWith("[")) {
      return {
        title: name,
        subtitle: raw,
        kind: "output-only",
        headerOnly: true,
      };
    }
    return {
      title: name,
      kind: "raw",
      writePreview: raw ? formatPayloadText(raw) : undefined,
    };
  }

  // ---- read / ls — OpenCode: header only (filename + offset/limit) ----
  if (lower === "read" || lower === "ls") {
    const path =
      asString(params.path) ??
      asString(params.file_path) ??
      asString(params.filePath) ??
      asString(params.target);
    const chips: string[] = [];
    if (params.offset !== undefined) chips.push(`offset=${params.offset}`);
    if (params.limit !== undefined) chips.push(`limit=${params.limit}`);
    return {
      title: lower,
      subtitle: path ? toolPathLabel(path) : undefined,
      args: chips.length ? chips : undefined,
      kind: "output-only",
      // read rarely needs expand; ls may show directory listing as output
      headerOnly: lower === "read",
    };
  }

  // ---- write / edit — subtitle = path; expand = content preview + result ----
  if (lower === "write" || lower === "edit") {
    const path =
      asString(params.path) ??
      asString(params.file_path) ??
      asString(params.filePath) ??
      asString(params.target);
    const content =
      asString(params.content) ?? asString(params.new_string) ?? asString(params.newString);
    return {
      title: lower,
      subtitle: path ? toolPathLabel(path) : undefined,
      kind: "write-body",
      writePreview: content ? formatPayloadText(content, 4_000) : undefined,
    };
  }

  // ---- grep / find — title + pattern/path; expand = matches only ----
  if (lower === "grep" || lower === "find") {
    const pattern = asString(params.pattern) ?? asString(params.query);
    const path = asString(params.path);
    const include = asString(params.include);
    // OpenCode: subtitle = directory, args = pattern=…
    // When no path, put pattern on the subtitle (common for our tools).
    if (path) {
      const chips: string[] = [];
      if (pattern) chips.push(`pattern=${truncateOneLine(pattern, 40)}`);
      if (include) chips.push(`include=${include}`);
      return {
        title: lower,
        subtitle: toolPathLabel(path),
        args: chips.length ? chips : undefined,
        kind: "output-only",
      };
    }
    return {
      title: lower,
      subtitle: pattern ? truncateOneLine(pattern, 56) : include,
      kind: "output-only",
    };
  }

  // ---- generic: pick one primary field as subtitle; no Input/Output dump ----
  const primaryKeys = [
    "path",
    "file_path",
    "filePath",
    "command",
    "query",
    "pattern",
    "url",
    "name",
    "title",
    "description",
    "message",
    "prompt",
  ];
  for (const key of primaryKeys) {
    const v = asString(params[key]);
    if (v) {
      return {
        title: name,
        subtitle: truncateOneLine(v, 64),
        kind: "output-only",
      };
    }
  }

  // Few scalar fields → pack into subtitle rather than JSON body
  const keys = Object.keys(params);
  if (keys.length > 0 && keys.length <= 4) {
    const parts = keys
      .map((k) => {
        const v = params[k];
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          return `${k}=${v}`;
        }
        return null;
      })
      .filter(Boolean) as string[];
    if (parts.length === keys.length) {
      return {
        title: name,
        subtitle: truncateOneLine(parts.join(" · "), 72),
        kind: "output-only",
        headerOnly: true,
      };
    }
  }

  // Last resort: unknown structured args — show compact one-liner, expand only result
  return {
    title: name,
    subtitle: truncateOneLine(keys.map((k) => k).join(", "), 48),
    kind: "output-only",
  };
}
