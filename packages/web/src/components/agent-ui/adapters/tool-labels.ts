/**
 * Map wire tool names to operator-facing product titles.
 * Labels are injected by the caller (i18n) so adapters stay pure.
 */

import type { ToolItemStatus } from "./types.ts";

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

export function inferToolKind(
  name: string,
): "generic" | "wiki_produce" | "read" | "write" | "search" {
  if (name === "wiki_produce") return "wiki_produce";
  if (name === "read" || name.startsWith("read_")) return "read";
  if (name === "write" || name.startsWith("write_")) return "write";
  if (name === "search" || name.startsWith("search_")) return "search";
  return "generic";
}
