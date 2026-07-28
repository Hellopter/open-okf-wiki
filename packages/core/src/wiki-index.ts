/**
 * Deterministic multi-level index.md regeneration (OKF §8 progressive disclosure).
 *
 * Every directory that owns concept pages (or child directories with concepts)
 * gets its own index.md. Parent listings link only to direct children — concept
 * basenames or `subdir/index.md` — never flattened descendants. Indexes are
 * always overwritten; root okf_version is stamped later by stampWikiTreeForPublish.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isReservedWikiPath,
  loadWikiPageRecords,
  scanWikiTree,
} from "./wiki-tree.js";
import { parseWikiIndexListing } from "./wiki-nav.js";

export type WikiIndexListEntry =
  | { kind: "page"; title: string; href: string; description?: string; type?: string }
  | { kind: "dir"; title: string; href: string; description?: string };

/** Product type group order; unknown types sort alphabetically after these. */
const PRODUCT_TYPE_ORDER: Record<string, number> = {
  overview: 0,
  architecture: 1,
  module: 2,
  flow: 3,
  concept: 4,
};

const SUBDIRECTORIES_HEADING = "Subdirectories";

type ConceptMeta = {
  /** Bundle-relative POSIX path (e.g. modules/core.md). */
  path: string;
  title: string;
  description?: string;
  type?: string;
};

function posixRel(raw: string): string {
  return raw.replace(/\\/g, "/");
}

function parentDir(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

function basename(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? relPath : relPath.slice(i + 1);
}

function typeGroupRank(heading: string): number {
  if (heading === SUBDIRECTORIES_HEADING) return 1000;
  const known = PRODUCT_TYPE_ORDER[heading.toLowerCase()];
  if (known !== undefined) return known;
  // Unknown types (including "Other") sort alphabetically after product types.
  return 100;
}

function compareTypeHeadings(a: string, b: string): number {
  const rank = typeGroupRank(a) - typeGroupRank(b);
  if (rank !== 0) return rank;
  return a.localeCompare(b);
}

function renderEntry(title: string, href: string, description?: string): string {
  const suffix = description ? ` - ${description}` : "";
  return `* [${title}](${href})${suffix}`;
}

/** Render a directory listing grouped by concept type, Subdirectories last. */
export function renderDirectoryIndex(entries: ReadonlyArray<WikiIndexListEntry>): string {
  const groups = new Map<string, Array<{ title: string; href: string; description?: string }>>();

  for (const entry of entries) {
    const heading =
      entry.kind === "dir" ? SUBDIRECTORIES_HEADING : entry.type?.trim() || "Other";
    const item = {
      title: entry.title,
      href: entry.href,
      ...(entry.description ? { description: entry.description } : {}),
    };
    const list = groups.get(heading);
    if (list) list.push(item);
    else groups.set(heading, [item]);
  }

  const headings = [...groups.keys()].sort(compareTypeHeadings);
  const sections: string[] = [];
  for (const heading of headings) {
    const items = groups.get(heading)!;
    items.sort(
      (a, b) => a.title.localeCompare(b.title) || a.href.localeCompare(b.href),
    );
    sections.push(
      [`# ${heading}`, "", ...items.map((e) => renderEntry(e.title, e.href, e.description))].join(
        "\n",
      ),
    );
  }
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

/** Deterministic directory blurb for parent listings (no LLM). */
function directoryDescription(
  concepts: ReadonlyArray<ConceptMeta>,
  childDirCount: number,
): string | undefined {
  if (concepts.length === 1 && concepts[0]!.description) {
    return concepts[0]!.description;
  }
  if (concepts.length === 0) {
    return childDirCount > 0
      ? `${childDirCount} ${childDirCount === 1 ? "subdirectory" : "subdirectories"}`
      : undefined;
  }
  const pages = `${concepts.length} ${concepts.length === 1 ? "page" : "pages"}`;
  if (childDirCount > 0) {
    return `${pages}, ${childDirCount} ${childDirCount === 1 ? "subdirectory" : "subdirectories"}`;
  }
  return pages;
}

function conceptsInSubtree(
  all: ReadonlyArray<ConceptMeta>,
  dirRel: string,
): ConceptMeta[] {
  if (dirRel === "") return [...all];
  const prefix = `${dirRel}/`;
  return all.filter((c) => c.path.startsWith(prefix));
}

function immediateChildDirs(all: ReadonlyArray<ConceptMeta>, dirRel: string): string[] {
  const names = new Set<string>();
  const prefix = dirRel ? `${dirRel}/` : "";
  for (const c of all) {
    if (dirRel && !c.path.startsWith(prefix)) continue;
    const rest = dirRel ? c.path.slice(prefix.length) : c.path;
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // direct page, not a child dir
    names.add(rest.slice(0, slash));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function directConceptPages(all: ReadonlyArray<ConceptMeta>, dirRel: string): ConceptMeta[] {
  return all.filter((c) => parentDir(c.path) === dirRel);
}

async function loadConcepts(wikiRoot: string): Promise<ConceptMeta[]> {
  const { pages } = await loadWikiPageRecords(wikiRoot);
  const concepts: ConceptMeta[] = [];
  for (const page of pages) {
    const rel = page.relativePath;
    if (isReservedWikiPath(rel)) continue;
    const stem = basename(rel).replace(/\.md$/i, "");
    concepts.push({
      path: rel,
      title: page.values.title || stem,
      ...(page.values.description ? { description: page.values.description } : {}),
      ...(page.values.type ? { type: page.values.type } : {}),
    });
  }
  return concepts;
}

/** Directories that need an index: every ancestor of a concept page, including root. */
function directoriesNeedingIndex(concepts: ReadonlyArray<ConceptMeta>): string[] {
  const dirs = new Set<string>();
  for (const c of concepts) {
    let cur = parentDir(c.path);
    // Always include the concept's parent and every ancestor up to root.
    for (;;) {
      dirs.add(cur);
      if (cur === "") break;
      cur = parentDir(cur);
    }
  }
  // Deepest first so child descriptions exist before parents list them.
  return [...dirs].sort((a, b) => {
    const depth = b.split("/").filter(Boolean).length - a.split("/").filter(Boolean).length;
    if (depth !== 0) return depth;
    return a.localeCompare(b);
  });
}

/** Bundle-relative paths of every existing index.md under wikiRoot. */
async function listExistingIndexPaths(wikiRoot: string): Promise<string[]> {
  const scan = await scanWikiTree(wikiRoot);
  return scan.files
    .map((f) => posixRel(f.relativePath))
    .filter((rel) => basename(rel).toLowerCase() === "index.md");
}

async function removeIndexFiles(
  wikiRoot: string,
  relPaths: ReadonlyArray<string>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of relPaths) {
    try {
      await unlink(path.join(wikiRoot, rel));
      removed.push(rel);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") throw error;
    }
  }
  removed.sort((a, b) => a.localeCompare(b));
  return removed;
}

/**
 * Regenerate every directory index.md under wikiRoot from concept frontmatter.
 * Always overwrites. Nested indexes are body-only (no frontmatter).
 * Stale index.md files (no longer needed by the concept set) are deleted.
 */
export async function regenerateWikiIndexes(
  wikiRoot: string,
): Promise<{ written: string[]; removed: string[] }> {
  const root = path.resolve(wikiRoot);
  const concepts = await loadConcepts(root);
  const existingIndexes = await listExistingIndexPaths(root);

  if (concepts.length === 0) {
    // No concepts → no indexes; drop every orphan listing under the tree.
    const removed = await removeIndexFiles(root, existingIndexes);
    return { written: [], removed };
  }

  const dirs = directoriesNeedingIndex(concepts);
  const neededIndexPaths = new Set(
    dirs.map((dirRel) => (dirRel ? `${dirRel}/index.md` : "index.md")),
  );
  const dirDescriptions = new Map<string, string>();
  const written: string[] = [];

  for (const dirRel of dirs) {
    const entries: WikiIndexListEntry[] = [];

    for (const page of directConceptPages(concepts, dirRel).sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      entries.push({
        kind: "page",
        title: page.title,
        href: basename(page.path),
        ...(page.description ? { description: page.description } : {}),
        ...(page.type ? { type: page.type } : {}),
      });
    }

    for (const childName of immediateChildDirs(concepts, dirRel)) {
      const childRel = dirRel ? `${dirRel}/${childName}` : childName;
      const desc = dirDescriptions.get(childRel);
      entries.push({
        kind: "dir",
        title: childName,
        href: `${childName}/index.md`,
        ...(desc ? { description: desc } : {}),
      });
    }

    if (entries.length === 0) continue;

    const body = renderDirectoryIndex(entries);
    const indexAbs = path.join(root, dirRel, "index.md");
    if (dirRel) {
      await mkdir(path.join(root, dirRel), { recursive: true });
    }
    await writeFile(indexAbs, body, "utf8");
    written.push(dirRel ? `${dirRel}/index.md` : "index.md");

    // Description used when this directory appears as a Subdirectories entry.
    if (dirRel !== "") {
      const subtree = conceptsInSubtree(concepts, dirRel);
      const childCount = immediateChildDirs(concepts, dirRel).length;
      const desc = directoryDescription(subtree, childCount);
      if (desc) dirDescriptions.set(dirRel, desc);
    }
  }

  // Garbage-collect indexes for directories that no longer own concepts.
  const stale = existingIndexes.filter((rel) => !neededIndexPaths.has(rel));
  const removed = await removeIndexFiles(root, stale);

  // Stable order for callers/tests.
  written.sort((a, b) => a.localeCompare(b));
  return { written, removed };
}

/** Project index listing links to hrefs (hash already stripped by parser). */
function parseIndexHrefs(content: string): string[] {
  return parseWikiIndexListing(content)
    .filter((entry): entry is Extract<typeof entry, { kind: "link" }> => entry.kind === "link")
    .map((entry) => entry.href)
    .filter(Boolean);
}

/**
 * True when href is a direct-child link from an index:
 * - page basename (`core.md`)
 * - child index (`modules/index.md`)
 * - child directory slash form (`modules/` or `modules`)
 * Rejects absolute paths and multi-segment deep concept links.
 */
function isDirectChildHref(href: string): boolean {
  const raw = href.trim();
  if (!raw || raw.includes("..")) return false;
  // Absolute site paths (e.g. /modules/core.md) are not progressive-disclosure children.
  if (raw.startsWith("/")) return false;
  const cleaned = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!cleaned) return false;
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 1) return true;
  if (parts.length === 2 && parts[1]!.toLowerCase() === "index.md") return true;
  return false;
}

function resolveChildTarget(
  href: string,
  indexDir: string,
): { kind: "page"; path: string } | { kind: "dir"; path: string } | null {
  if (!isDirectChildHref(href)) return null;
  let cleaned = href.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/")) return null;
  cleaned = cleaned.replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  const join = (name: string) => (indexDir ? `${indexDir}/${name}` : name);

  if (parts.length === 1) {
    const name = parts[0]!;
    if (name.toLowerCase().endsWith(".md")) {
      return { kind: "page", path: join(name) };
    }
    return { kind: "dir", path: join(name) };
  }
  if (parts.length === 2 && parts[1]!.toLowerCase() === "index.md") {
    return { kind: "dir", path: join(parts[0]!) };
  }
  return null;
}

/**
 * Structural invariants for multi-level indexes (post-regenerate or for score).
 */
export async function validateWikiIndexes(
  wikiRoot: string,
): Promise<{ ok: boolean; errors: string[] }> {
  const root = path.resolve(wikiRoot);
  const concepts = await loadConcepts(root);
  const errors: string[] = [];

  if (concepts.length === 0) {
    return { ok: true, errors: [] };
  }

  const neededDirs = directoriesNeedingIndex(concepts);
  const conceptSet = new Set(concepts.map((c) => c.path));
  const indexContents = new Map<string, string>();

  for (const dirRel of neededDirs) {
    const indexRel = dirRel ? `${dirRel}/index.md` : "index.md";
    const indexAbs = path.join(root, indexRel);
    let content: string;
    try {
      content = await readFile(indexAbs, "utf8");
    } catch {
      errors.push(`missing index.md for directory with concepts: ${dirRel || "."}`);
      continue;
    }
    indexContents.set(indexRel, content);

    for (const href of parseIndexHrefs(content)) {
      if (!isDirectChildHref(href)) {
        errors.push(`${indexRel}: deep or non-direct link not allowed: ${href}`);
      }
    }
  }

  // Coverage: every concept reachable via index link chain from root.
  const covered = new Set<string>();
  const queue = ["index.md"];
  const seenIndexes = new Set<string>();
  while (queue.length > 0) {
    const indexRel = queue.pop()!;
    if (seenIndexes.has(indexRel)) continue;
    seenIndexes.add(indexRel);
    const content = indexContents.get(indexRel);
    if (!content) continue;
    const indexDir = parentDir(indexRel);
    for (const href of parseIndexHrefs(content)) {
      const target = resolveChildTarget(href, indexDir);
      if (!target) continue;
      if (target.kind === "page") {
        if (conceptSet.has(target.path)) covered.add(target.path);
      } else {
        const childIndex = `${target.path}/index.md`;
        if (indexContents.has(childIndex) || neededDirs.includes(target.path)) {
          queue.push(childIndex);
        }
      }
    }
  }

  for (const c of concepts) {
    if (!covered.has(c.path)) {
      errors.push(`concept not reachable from root index chain: ${c.path}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
