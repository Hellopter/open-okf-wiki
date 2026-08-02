import type { WikiRunListItem } from "../api";
import type { MessageTree } from "../i18n";

export function localizedLabel(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value.replaceAll("_", " ");
}

export function runLabel(run: WikiRunListItem, t: MessageTree): string {
  return run.phase
    ? run.phase.replaceAll("_", " ")
    : localizedLabel(t.workbench.runStates, run.state);
}

export function runBadge(
  run: WikiRunListItem,
): "default" | "secondary" | "outline" | "destructive" {
  if (run.state === "failed" || run.state === "cancelled") return "destructive";
  if (run.attention === "gate" || run.attention === "review" || run.attention === "paused")
    return "outline";
  return run.state === "published" ? "default" : "secondary";
}

export function promptTitle(text: string): string | undefined {
  const firstLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}
