/**
 * Deterministic OKF §9 log.md maintenance for publish candidates.
 *
 * The Run Boundary owns log.md as mechanical history: on publish it diffs the
 * candidate tree against the live publication, prepends a date-grouped section
 * (newest first, ISO dates), and carries the previous published log forward.
 * Reserved files (index.md / log.md) are navigation, not knowledge, so only
 * concept pages appear as entries.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isReservedWikiPath, parseWikiFrontmatter, scanWikiTree } from "./wiki-tree.js";

export const WIKI_LOG_HEADING = "# Wiki Update Log";

export type WikiLogChange = {
  kind: "Creation" | "Update" | "Removal";
  /** Bundle-relative POSIX path. */
  path: string;
  /** Frontmatter title when known (links read better than bare paths). */
  title?: string;
};

/**
 * Strip Run Boundary-stamped provenance before content comparison: `generated`
 * timestamps change on every publish and must not turn identical pages into
 * spurious Update entries.
 */
export function stripProvenanceForDiff(content: string): string {
  return content
    .split("\n")
    .filter(
      (line) =>
        !/^(generated|verified|okf_version)\s*:/.test(line) && !/^\s+-\s+\{\s*by:/.test(line),
    )
    .join("\n");
}

/** Diff two page-content maps (bundle-relative path → raw content). */
export function diffWikiPages(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  titles: ReadonlyMap<string, string>,
): WikiLogChange[] {
  const changes: WikiLogChange[] = [];
  const consider = (p: string) => p.toLowerCase().endsWith(".md") && !isReservedWikiPath(p);

  for (const [pagePath, content] of next) {
    if (!consider(pagePath)) continue;
    const before = previous.get(pagePath);
    const title = titles.get(pagePath);
    if (before === undefined) {
      changes.push({ kind: "Creation", path: pagePath, ...(title ? { title } : {}) });
    } else if (stripProvenanceForDiff(before) !== stripProvenanceForDiff(content)) {
      changes.push({ kind: "Update", path: pagePath, ...(title ? { title } : {}) });
    }
  }
  for (const pagePath of previous.keys()) {
    if (!consider(pagePath)) continue;
    if (!next.has(pagePath)) {
      changes.push({ kind: "Removal", path: pagePath });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

function renderEntry(change: WikiLogChange): string {
  const label = change.title || change.path;
  switch (change.kind) {
    case "Creation":
      return `* **Creation**: Added [${label}](/${change.path}).`;
    case "Update":
      return `* **Update**: Updated [${label}](/${change.path}).`;
    case "Removal":
      return `* **Removal**: Removed ${change.path}.`;
  }
}

/**
 * Render the updated log: heading, the new date section, then prior sections.
 * When the previous log already starts with the same date, its entries merge
 * under one heading (multiple publishes per day) with exact-duplicate lines
 * dropped.
 */
export function renderWikiLog(input: {
  /** ISO `YYYY-MM-DD` for the new section. */
  date: string;
  changes: WikiLogChange[];
  /** Previous published log.md content, carried forward. */
  previousLog?: string;
}): string {
  const newEntries = input.changes.map(renderEntry);
  let prior = (input.previousLog ?? "").trim();
  if (prior.startsWith(WIKI_LOG_HEADING)) {
    prior = prior.slice(WIKI_LOG_HEADING.length).trim();
  }

  const sameDateHeading = `## ${input.date}`;
  if (prior.startsWith(sameDateHeading)) {
    const rest = prior.slice(sameDateHeading.length);
    const nextSection = rest.search(/^## /m);
    const existingEntries = (nextSection < 0 ? rest : rest.slice(0, nextSection))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("* "));
    const merged = [...newEntries, ...existingEntries.filter((l) => !newEntries.includes(l))];
    prior = nextSection < 0 ? "" : rest.slice(nextSection).trim();
    return [
      WIKI_LOG_HEADING,
      "",
      sameDateHeading,
      ...merged,
      ...(prior ? ["", prior] : []),
      "",
    ].join("\n");
  }

  return [
    WIKI_LOG_HEADING,
    "",
    sameDateHeading,
    ...newEntries,
    ...(prior ? ["", prior] : []),
    "",
  ].join("\n");
}

async function readTreePages(root: string | undefined): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  if (!root) return pages;
  let scan;
  try {
    scan = await scanWikiTree(root);
  } catch {
    return pages;
  }
  for (const file of scan.files) {
    const rel = file.relativePath.replace(/\\/g, "/");
    if (!rel.toLowerCase().endsWith(".md")) continue;
    try {
      pages.set(rel, await readFile(file.absolutePath, "utf8"));
    } catch {
      // Unreadable previous pages simply drop out of the diff.
    }
  }
  return pages;
}

/**
 * Write the candidate's root log.md from the candidate/live diff.
 * Call before provenance stamping (the diff strips stamps defensively anyway).
 * Returns the number of change entries written for this publish.
 */
export async function updateWikiLogForPublish(input: {
  candidateDir: string;
  /** Live publication root; undefined on first publish. */
  previousDir?: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
}): Promise<{ changes: number }> {
  const next = await readTreePages(input.candidateDir);
  const previous = await readTreePages(input.previousDir);

  const titles = new Map<string, string>();
  for (const [pagePath, content] of next) {
    const title = parseWikiFrontmatter(content)?.values.title;
    if (title) titles.set(pagePath, title);
  }

  const changes = diffWikiPages(previous, next, titles);
  if (changes.length === 0 && !previous.has("log.md")) {
    return { changes: 0 };
  }

  const log = renderWikiLog({
    date: input.date,
    changes,
    ...(previous.has("log.md") ? { previousLog: previous.get("log.md")! } : {}),
  });
  await writeFile(path.join(input.candidateDir, "log.md"), log, "utf8");
  return { changes: changes.length };
}
