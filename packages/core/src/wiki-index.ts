/**
 * Deterministic root index.md generation (OKF §8 progressive disclosure).
 *
 * Only fills the gap: when the candidate tree has no root index.md, one is
 * synthesized from concept frontmatter (title + description, grouped by top
 * directory). A model-written listing is never overwritten — the Producer
 * Skill owns listing structure when it chooses to write one.
 */

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isReservedWikiPath, parseWikiFrontmatter, scanWikiTree } from "./wiki-tree.js";

type IndexEntry = {
  path: string;
  title: string;
  description?: string;
};

function renderEntry(entry: IndexEntry): string {
  const suffix = entry.description ? ` - ${entry.description}` : "";
  return `* [${entry.title}](/${entry.path})${suffix}`;
}

/** Render a root listing grouped by top-level directory (root group first). */
export function renderRootIndex(
  pages: ReadonlyArray<{ path: string; title?: string; description?: string }>,
): string {
  const groups = new Map<string, IndexEntry[]>();
  for (const page of pages) {
    const posix = page.path.replace(/\\/g, "/");
    if (!posix.toLowerCase().endsWith(".md") || isReservedWikiPath(posix)) continue;
    const top = posix.includes("/") ? posix.slice(0, posix.indexOf("/")) : "";
    const entry: IndexEntry = {
      path: posix,
      title: page.title || posix,
      ...(page.description ? { description: page.description } : {}),
    };
    const list = groups.get(top);
    if (list) list.push(entry);
    else groups.set(top, [entry]);
  }

  const sections: string[] = [];
  const emit = (heading: string, entries: IndexEntry[]) => {
    entries.sort((a, b) => a.path.localeCompare(b.path));
    sections.push([`# ${heading}`, "", ...entries.map(renderEntry)].join("\n"));
  };

  const rootEntries = groups.get("");
  if (rootEntries) emit("Pages", rootEntries);
  for (const top of [...groups.keys()].filter(Boolean).sort()) {
    emit(`${top}/`, groups.get(top)!);
  }
  return `${sections.join("\n\n")}\n`;
}

/**
 * Generate the candidate's root index.md when missing.
 * Returns true when a listing was written.
 */
export async function generateRootIndexIfMissing(candidateDir: string): Promise<boolean> {
  try {
    await access(path.join(candidateDir, "index.md"));
    return false; // model-written listing wins
  } catch {
    // missing → synthesize below
  }

  const scan = await scanWikiTree(candidateDir);
  const pages: Array<{ path: string; title?: string; description?: string }> = [];
  for (const file of scan.files) {
    const rel = file.relativePath.replace(/\\/g, "/");
    if (!rel.toLowerCase().endsWith(".md") || isReservedWikiPath(rel)) continue;
    const values = parseWikiFrontmatter(await readFile(file.absolutePath, "utf8"))?.values;
    pages.push({
      path: rel,
      ...(values?.title ? { title: values.title } : {}),
      ...(values?.description ? { description: values.description } : {}),
    });
  }
  if (pages.length === 0) return false;

  await writeFile(path.join(candidateDir, "index.md"), renderRootIndex(pages), "utf8");
  return true;
}
