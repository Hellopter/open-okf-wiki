/**
 * Reader navigation for a Published Wiki (progressive disclosure).
 *
 * Authority: each directory's `index.md` listing order and `#` section groups
 * (OKF §8). Filesystem paths fill structure when an index is missing; concept
 * pages never listed in any consumed index appear under a trailing Unlisted
 * group. Reserved `index.md` / `log.md` are never concept leaves.
 *
 * Layout:
 * - Pure parse: {@link parseWikiIndexListing}
 * - Recursive build: {@link buildWikiNav} / buildFromIndex
 * - Path-tree fallback (module-internal helper, not a public barrel export)
 */

import { resolveWikiLinkTarget } from "./wiki-links.js";
import { isReservedWikiPath, parseWikiFrontmatter, wikiMarkdownBody } from "./wiki-tree.js";

/** Stable group marker for pages missing from every consumed index. */
export const WIKI_NAV_UNLISTED_TITLE = "Unlisted";

export type WikiNavPageNode = {
  kind: "page";
  path: string;
  title?: string;
};

export type WikiNavDirNode = {
  kind: "dir";
  /** Directory prefix without trailing slash (e.g. `modules`). */
  path: string;
  title: string;
  children: WikiNavNode[];
};

export type WikiNavGroupNode = {
  kind: "group";
  title: string;
  children: WikiNavNode[];
  /** When `unlisted`, UI may localize the title. */
  source?: "index" | "unlisted" | "fallback";
};

export type WikiNavNode = WikiNavPageNode | WikiNavDirNode | WikiNavGroupNode;

export type WikiNavPageInput = {
  /** Bundle-relative POSIX path. */
  path: string;
  content: string;
  title?: string;
  type?: string;
};

export type WikiIndexEntry =
  | { kind: "heading"; title: string }
  | { kind: "link"; title: string; href: string; description?: string };

const TYPE_ORDER: Record<string, number> = {
  overview: 0,
  architecture: 1,
  module: 2,
  flow: 3,
  concept: 4,
};

const HEADING_RE = /^(#{1,2})\s+(.+?)\s*$/;
const LIST_LINK_RE = /^[*+-]\s+\[([^\]]+)\]\(([^)\s]+)\)(?:\s*[-–—:]\s*(.+?))?\s*$/;

function posixPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

// ---------------------------------------------------------------------------
// Pure parse
// ---------------------------------------------------------------------------

/** Parse an OKF-style directory listing into ordered headings and links. */
export function parseWikiIndexListing(content: string): WikiIndexEntry[] {
  const body = wikiMarkdownBody(content);
  const entries: WikiIndexEntry[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const title = heading[2]!.trim();
      if (title) entries.push({ kind: "heading", title });
      continue;
    }
    const link = LIST_LINK_RE.exec(line);
    if (link) {
      const title = link[1]!.trim();
      let href = link[2]!.trim();
      // Drop fragment; navigation targets whole pages.
      // Fragment-only hrefs (`#section`) become empty and are skipped below.
      const hash = href.indexOf("#");
      if (hash >= 0) href = href.slice(0, hash);
      if (!title || !href) continue;
      const description = link[3]?.trim();
      entries.push({
        kind: "link",
        title,
        href,
        ...(description ? { description } : {}),
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Path-tree fallback (module helper; not a public barrel export)
// ---------------------------------------------------------------------------

function typeRank(type: string | undefined): number {
  if (!type) return 50;
  return TYPE_ORDER[type.toLowerCase()] ?? 40;
}

function pageLabel(
  path: string,
  meta: ReadonlyMap<string, { title?: string; type?: string }>,
  fallbackTitle?: string,
): string | undefined {
  return meta.get(path)?.title || fallbackTitle || undefined;
}

function sortPagePaths(
  paths: string[],
  meta: ReadonlyMap<string, { title?: string; type?: string }>,
): string[] {
  return [...paths].sort((a, b) => {
    const rank = typeRank(meta.get(a)?.type) - typeRank(meta.get(b)?.type);
    if (rank !== 0) return rank;
    const ta = meta.get(a)?.title || a;
    const tb = meta.get(b)?.title || b;
    return ta.localeCompare(tb) || a.localeCompare(b);
  });
}

/**
 * Build the set of directory prefixes that contain at least one concept page.
 * Answers "any concept under path?" in O(1) via Set membership.
 */
function buildConceptDirPrefixes(conceptPaths: ReadonlySet<string>): ReadonlySet<string> {
  const prefixes = new Set<string>();
  for (const raw of conceptPaths) {
    const path = posixPath(raw);
    const parts = path.split("/").filter(Boolean);
    let prefix = "";
    // All ancestors of the leaf file are directory prefixes.
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]!;
      prefixes.add(prefix);
    }
  }
  return prefixes;
}

/** Path-segment tree for concept pages only; type-aware leaf order. */
export function buildWikiNavPathTree(
  conceptPaths: readonly string[],
  meta: ReadonlyMap<string, { title?: string; type?: string }>,
): WikiNavNode[] {
  type Mutable = {
    name: string;
    path: string;
    kind: "file" | "dir";
    children?: Map<string, Mutable>;
  };

  const root = new Map<string, Mutable>();
  for (const raw of conceptPaths) {
    const path = posixPath(raw);
    if (!path || path.includes("..") || isReservedWikiPath(path)) continue;
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let cursor = root;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isFile = i === parts.length - 1;
      prefix = prefix ? `${prefix}/${part}` : part;
      let node = cursor.get(part);
      if (!node) {
        node = {
          name: part,
          path: prefix,
          kind: isFile ? "file" : "dir",
          children: isFile ? undefined : new Map(),
        };
        cursor.set(part, node);
      } else if (!isFile && node.kind === "file") {
        // dir→file promotion: a longer path reuses a segment that was a leaf.
        node.kind = "dir";
        node.children = node.children ?? new Map();
      }
      if (!isFile) {
        node.children = node.children ?? new Map();
        cursor = node.children;
      }
    }
  }

  function toList(map: Map<string, Mutable>): WikiNavNode[] {
    const dirs: WikiNavDirNode[] = [];
    const files: string[] = [];
    for (const n of map.values()) {
      if (n.kind === "dir" && n.children) {
        dirs.push({
          kind: "dir",
          path: n.path,
          title: n.name,
          children: toList(n.children),
        });
      } else {
        files.push(n.path);
      }
    }
    dirs.sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
    const pages: WikiNavPageNode[] = sortPagePaths(files, meta).map((p) => {
      const title = pageLabel(p, meta);
      return title ? { kind: "page", path: p, title } : { kind: "page", path: p };
    });
    // Dirs before pages at each level.
    return [...dirs, ...pages];
  }

  return toList(root);
}

// ---------------------------------------------------------------------------
// Recursive build
// ---------------------------------------------------------------------------

function indexPathForDirectory(dirPrefix: string): string {
  return dirPrefix ? `${dirPrefix}/index.md` : "index.md";
}

function directoryPrefixOfIndex(indexPath: string): string {
  const normalized = posixPath(indexPath);
  if (normalized === "index.md") return "";
  if (normalized.endsWith("/index.md")) {
    return normalized.slice(0, -"/index.md".length);
  }
  return "";
}

function resolveIndexTarget(
  href: string,
  fromIndexPath: string,
  conceptPaths: ReadonlySet<string>,
  indexContents: ReadonlyMap<string, string>,
  conceptDirPrefixes: ReadonlySet<string>,
): { kind: "page"; path: string } | { kind: "dir"; path: string; indexPath: string } | null {
  let target = href.trim();
  if (!target) return null;

  // OKF allows bare directory entries: `subdir/` → subdir/index.md
  if (target.endsWith("/")) {
    target = `${target}index.md`;
  }

  const resolved = resolveWikiLinkTarget(target, fromIndexPath);
  if (!resolved) return null;
  const path = posixPath(resolved);
  if (!path || path.includes("..")) return null;

  const basenames = path.split("/").pop()?.toLowerCase() ?? "";
  if (basenames === "log.md") return null;

  if (basenames === "index.md") {
    const dir = directoryPrefixOfIndex(path);
    return { kind: "dir", path: dir, indexPath: path };
  }

  if (conceptPaths.has(path)) {
    return { kind: "page", path };
  }

  // Link to a directory name without trailing slash / index: modules → modules/index.md
  if (!path.toLowerCase().endsWith(".md")) {
    const indexPath = indexPathForDirectory(path);
    if (indexContents.has(indexPath) || conceptDirPrefixes.has(path)) {
      return { kind: "dir", path, indexPath };
    }
  }

  return null;
}

type NavBuildContext = {
  conceptPaths: ReadonlySet<string>;
  /** Directory prefixes with ≥1 concept descendant; O(1) "any under path?" */
  conceptDirPrefixes: ReadonlySet<string>;
  meta: ReadonlyMap<string, { title?: string; type?: string }>;
  indexContents: ReadonlyMap<string, string>;
  covered: Set<string>;
  /**
   * Indexes currently on the recursive build stack.
   * A→B→A cross-index cycles return empty children for the back-edge (no hang).
   */
  buildingIndexes: Set<string>;
};

function flushGroup(
  title: string | null,
  children: WikiNavNode[],
  into: WikiNavNode[],
  source: WikiNavGroupNode["source"] = "index",
): void {
  if (children.length === 0) return;
  if (title) {
    into.push({ kind: "group", title, children, source });
  } else {
    into.push(...children);
  }
}

/**
 * Nested dir nodes already carry a title; a sole section heading from the child
 * index is usually redundant (`Modules` → `# modules/` → pages).
 * Always expands when the child result is exactly one group.
 */
function unwrapSoleGroup(nodes: WikiNavNode[]): WikiNavNode[] {
  if (nodes.length === 1 && nodes[0]!.kind === "group") {
    return nodes[0]!.children;
  }
  return nodes;
}

function buildFromIndex(indexPath: string, ctx: NavBuildContext): WikiNavNode[] {
  const content = ctx.indexContents.get(indexPath);
  if (!content) return [];
  // Cycle guard: re-entering an index already on the stack yields nothing.
  if (ctx.buildingIndexes.has(indexPath)) return [];
  ctx.buildingIndexes.add(indexPath);

  try {
    const entries = parseWikiIndexListing(content);
    const out: WikiNavNode[] = [];
    let groupTitle: string | null = null;
    let groupChildren: WikiNavNode[] = [];

    const pushNode = (node: WikiNavNode | null) => {
      if (!node) return;
      groupChildren.push(node);
    };

    for (const entry of entries) {
      if (entry.kind === "heading") {
        flushGroup(groupTitle, groupChildren, out);
        groupTitle = entry.title;
        groupChildren = [];
        continue;
      }

      const resolved = resolveIndexTarget(
        entry.href,
        indexPath,
        ctx.conceptPaths,
        ctx.indexContents,
        ctx.conceptDirPrefixes,
      );
      if (!resolved) continue;

      if (resolved.kind === "page") {
        // First listing wins: later indexes / links skip already-covered pages.
        if (ctx.covered.has(resolved.path)) continue;
        ctx.covered.add(resolved.path);
        const title = pageLabel(resolved.path, ctx.meta, entry.title);
        pushNode(
          title
            ? { kind: "page", path: resolved.path, title }
            : { kind: "page", path: resolved.path },
        );
        continue;
      }

      // Directory / nested index — skip if that index is already on the stack.
      if (ctx.buildingIndexes.has(resolved.indexPath)) continue;
      let children: WikiNavNode[];
      if (ctx.indexContents.has(resolved.indexPath)) {
        children = unwrapSoleGroup(buildFromIndex(resolved.indexPath, ctx));
      } else {
        const prefix = resolved.path ? `${resolved.path}/` : "";
        const under = [...ctx.conceptPaths].filter(
          (p) => (prefix ? p.startsWith(prefix) : !p.includes("/")) && !ctx.covered.has(p),
        );
        for (const p of under) ctx.covered.add(p);
        children = buildWikiNavPathTree(under, ctx.meta);
      }
      // Empty after covered filtering: omit the dir node entirely.
      if (children.length === 0) continue;
      pushNode({
        kind: "dir",
        path: resolved.path,
        title: entry.title || resolved.path || "Wiki",
        children,
      });
    }

    flushGroup(groupTitle, groupChildren, out);
    return out;
  } finally {
    ctx.buildingIndexes.delete(indexPath);
  }
}

/**
 * Build reader navigation for a wiki page set.
 *
 * Prefers root `index.md` order/groups; falls back to a type-aware path tree.
 * Unlisted concept pages are appended under {@link WIKI_NAV_UNLISTED_TITLE}.
 */
export function buildWikiNav(pages: ReadonlyArray<WikiNavPageInput>): WikiNavNode[] {
  const meta = new Map<string, { title?: string; type?: string }>();
  const indexContents = new Map<string, string>();
  const conceptPaths = new Set<string>();

  for (const page of pages) {
    const path = posixPath(page.path);
    if (!path.toLowerCase().endsWith(".md")) continue;

    if (isReservedWikiPath(path)) {
      const base = path.split("/").pop()?.toLowerCase() ?? "";
      if (base === "index.md") {
        indexContents.set(path, page.content);
      }
      // Reserved basenames (index.md / log.md) are never concept leaves.
      continue;
    }

    conceptPaths.add(path);
    const fromFm = parseWikiFrontmatter(page.content)?.values;
    const title = page.title || fromFm?.title;
    const type = page.type || fromFm?.type;
    meta.set(path, {
      ...(title ? { title } : {}),
      ...(type ? { type } : {}),
    });
  }

  const covered = new Set<string>();
  const ctx: NavBuildContext = {
    conceptPaths,
    conceptDirPrefixes: buildConceptDirPrefixes(conceptPaths),
    meta,
    indexContents,
    covered,
    buildingIndexes: new Set(),
  };

  let nav: WikiNavNode[];
  if (indexContents.has("index.md")) {
    nav = buildFromIndex("index.md", ctx);
  } else {
    // No root listing: path tree with type-aware leaf order.
    nav = buildWikiNavPathTree([...conceptPaths], meta);
    for (const p of conceptPaths) covered.add(p);
  }

  const orphans = sortPagePaths(
    [...conceptPaths].filter((p) => !covered.has(p)),
    meta,
  );
  if (orphans.length > 0) {
    const orphanTree = buildWikiNavPathTree(orphans, meta);
    nav = [
      ...nav,
      {
        kind: "group",
        title: WIKI_NAV_UNLISTED_TITLE,
        children: orphanTree,
        source: "unlisted",
      },
    ];
  }

  return nav;
}

/** Depth-first first concept page path in a nav tree. */
export function firstWikiNavPage(nodes: readonly WikiNavNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind === "page") return node.path;
    if (node.kind === "dir" || node.kind === "group") {
      const found = firstWikiNavPage(node.children);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Default browse target: first nav page, else `overview.md` when present,
 * else the first concept path in sorted order.
 */
export function defaultWikiBrowsePage(
  nav: readonly WikiNavNode[],
  conceptPaths: readonly string[],
): string | undefined {
  const fromNav = firstWikiNavPage(nav);
  if (fromNav) return fromNav;
  if (conceptPaths.includes("overview.md")) return "overview.md";
  const concepts = conceptPaths.filter((p) => !isReservedWikiPath(p));
  return concepts[0];
}
