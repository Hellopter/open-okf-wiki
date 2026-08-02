/**
 * Map wire tool names to operator-facing product titles.
 * Labels are injected by the caller (i18n) so adapters stay pure.
 */

import type { ToolItemKind, ToolItemStatus } from "./types.ts";

export type ToolNameLabels = {
  /** Product title for the wiki_produce tool. */
  wikiProduce?: string;
  /** Localized status badge labels keyed by ToolItemStatus. */
  status?: Partial<Record<ToolItemStatus, string>>;
};

/** Known product titles; falls back to spaced technical name. */
export function toolProductTitle(name: string, labels: ToolNameLabels = {}): string {
  if (name === "wiki_produce") {
    return labels.wikiProduce ?? "Generate wiki";
  }
  return name.replaceAll("_", " ");
}

/** Resolve a localized status label from injected labels. */
export function toolStatusLabel(
  status: ToolItemStatus,
  labels: ToolNameLabels = {},
): string | undefined {
  return labels.status?.[status];
}

export function inferToolKind(name: string): ToolItemKind {
  const lower = name.toLowerCase();
  if (lower === "wiki_produce") return "wiki_produce";

  // Search / find
  if (
    lower === "search" ||
    lower === "grep" ||
    lower === "glob" ||
    lower.startsWith("search_") ||
    lower.includes("grep") ||
    lower.includes("glob") ||
    lower.includes("find")
  ) {
    return "search";
  }

  // Read / list
  if (
    lower === "read" ||
    lower === "ls" ||
    lower === "list" ||
    lower === "list_dir" ||
    lower === "cat" ||
    lower.startsWith("read_") ||
    lower.startsWith("list_") ||
    lower.includes("read_file")
  ) {
    return "read";
  }

  // Write / edit
  if (
    lower === "write" ||
    lower === "edit" ||
    lower === "apply_patch" ||
    lower.startsWith("write_") ||
    lower.startsWith("edit_") ||
    lower.includes("write_file") ||
    lower.includes("search_replace")
  ) {
    return "write";
  }

  // bash/shell stay generic (command execution)
  return "generic";
}
