/**
 * Staging Wiki page helpers shared by fixture runtime and root_write.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { regenerateWikiIndexes, scanWikiTree } from "@okf-wiki/core";
import type { RunWorkdirLayout } from "./workdir.js";

export async function listWikiMarkdown(wikiDir: string): Promise<string[]> {
  const scan = await scanWikiTree(wikiDir);
  const missing = scan.issues.some(
    (issue) => issue.relativePath === "." && issue.code === "ENOENT",
  );
  if (missing) return [];
  if (scan.issues[0]) throw new Error(scan.issues[0].message);
  return scan.files
    .map((file) => file.relativePath)
    .filter((relativePath) => relativePath.toLowerCase().endsWith(".md"));
}

/**
 * Materialize multi-level directory indexes after write/repair (fail closed).
 * Always overwrites every directory's index.md from concept frontmatter and
 * removes stale index.md files that no longer match the concept set.
 */
export async function materializeWikiIndexes(
  wikiDir: string,
): Promise<{ written: string[]; removed: string[] }> {
  return regenerateWikiIndexes(wikiDir);
}

/**
 * Fixture wiki: concept overview with type+title+citation, then mechanical indexes
 * (same materialize path as production write/repair).
 */
export async function writeFixtureWiki(layout: RunWorkdirLayout, title: string): Promise<string[]> {
  await mkdir(layout.wikiDir, { recursive: true });
  const overview = [
    "---",
    "type: Overview",
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    `# ${title}`,
    "",
    "This page was produced in **Pi fixture mode** (no LLM call).",
    "",
    "Layout:",
    "- `sources/` — registered source mounts",
    "- `skill/` — Producer Skill",
    "- `wiki/` — Staging Wiki",
    "- `analysis/` — run analysis",
    "",
    "Grounding: [Source](repo:README.md#L1).",
    "",
    "This page is a pipeline smoke fixture (no LLM). Use live mode with API credentials for real generation.",
    "",
  ].join("\n");

  await writeFile(path.join(layout.wikiDir, "overview.md"), overview, "utf8");
  // Product-owned progressive-disclosure listings (overwrite any hand-written TOC).
  await materializeWikiIndexes(layout.wikiDir);
  return listWikiMarkdown(layout.wikiDir);
}
