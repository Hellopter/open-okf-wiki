/**
 * Staging Wiki page helpers shared by fixture runtime and root_write.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanWikiTree } from "@okf-wiki/core";
import type { RunWorkdirLayout } from "../runtime/workdir.js";

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

/** Fixture wiki: concept overview with type+title+citation; listing-only index.md. */
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

  const index = [
    `# ${title}`,
    "",
    "* [Overview](overview.md) - Repository overview (fixture)",
    "",
  ].join("\n");

  await writeFile(path.join(layout.wikiDir, "overview.md"), overview, "utf8");
  await writeFile(path.join(layout.wikiDir, "index.md"), index, "utf8");
  return ["index.md", "overview.md"];
}
