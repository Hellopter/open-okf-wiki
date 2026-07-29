/**
 * Internal wiki cross-link extraction and graph derivation (Wiki Visualization).
 *
 * Deterministic, read-only derivation over a page set: markdown `.md` links
 * become directed edges of an untyped relationship (OKF v0.2 §6.1). Broken
 * links are reported, never rejected — OKF consumers must tolerate them.
 *
 * Excluded from linking:
 * - scheme links (`repo:`, `https:`, …) — Source Citations and external URLs
 * - the `sources/` namespace — publish rewrites citations into it
 * - self-links and duplicate edges
 */

import {
  isReservedWikiPath,
  loadWikiPageRecords,
  parseWikiFrontmatter,
  wikiMarkdownBody,
} from "./wiki-tree.js";

export type WikiTrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export type WikiGraphNode = {
  /** Bundle-relative POSIX path (e.g. `modules/core.md`). */
  path: string;
  type?: string;
  title?: string;
  description?: string;
  tags?: string[];
  /** From the stamped `generated` mapping when present. */
  generatedBy?: string;
  generatedAt?: string;
  /** Derived from `verified` actors per OKF v0.2 §5.3. */
  trustTier: WikiTrustTier;
};

export type WikiGraphEdge = {
  /** Source page path. */
  from: string;
  /** Target page path (exists in the tree). */
  to: string;
};

export type WikiBrokenLink = {
  /** Page containing the link (may be a reserved listing). */
  from: string;
  /** Original link target as written. */
  target: string;
  /** Normalized bundle-relative resolution, when resolvable. */
  resolved?: string;
};

export type WikiGraph = {
  /** Concept pages only (reserved index.md / log.md are navigation, not knowledge). */
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  /** Broken internal links across all pages, reserved listings included. */
  brokenLinks: WikiBrokenLink[];
};

export type WikiGraphInputPage = {
  /** Bundle-relative POSIX path. */
  path: string;
  content: string;
};

const MD_LINK_RE = /\]\(([^()\s]+?\.md)(#[^()\s]*)?\)/g;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Resolve a link target against its page directory to a bundle-relative path. */
export function resolveWikiLinkTarget(target: string, fromPage: string): string | null {
  if (!target || SCHEME_RE.test(target) || target.startsWith("//")) return null;
  const bundleAbsolute = target.startsWith("/");
  const base = bundleAbsolute ? [] : fromPage.split("/").slice(0, -1).filter(Boolean);
  const segments = [...base];
  for (const part of target.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null; // escapes the bundle root
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const resolved = segments.join("/");
  return resolved || null;
}

/**
 * Extract internal `.md` link targets from one page body (frontmatter excluded).
 * Returns raw targets in document order, without fragments, deduplicated.
 */
export function extractInternalLinkTargets(content: string): string[] {
  const body = wikiMarkdownBody(content);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MD_LINK_RE)) {
    const target = match[1]!;
    if (SCHEME_RE.test(target) || target.startsWith("//")) continue;
    if (!seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function parseFlowMapping(raw: string): Record<string, string> {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  const values: Record<string, string> = {};
  for (const pair of inner.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    let value = pair.slice(idx + 1).trim();
    // Rejoin actor values like okf-wiki/model with embedded colons handled by
    // quoting; strip surrounding quotes either way.
    value = value.replace(/^["']/, "").replace(/["']$/, "");
    if (key && value) values[key] = value;
  }
  return values;
}

/** Split a frontmatter inline list like `[a, b]` into trimmed entries. */
function parseInlineList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((entry) => entry.trim().replace(/^["']/, "").replace(/["']$/, ""))
    .filter(Boolean);
}

/** Derive the OKF v0.2 trust tier from raw frontmatter text (§5.3). */
export function trustTierFromFrontmatter(frontmatterText: string): WikiTrustTier {
  if (!/^\s*verified\s*:/m.test(frontmatterText)) return "unverified";
  return /by\s*:\s*["']?human:/.test(frontmatterText) ? "human-reviewed" : "machine-confirmed";
}

function nodeFromPage(page: WikiGraphInputPage): WikiGraphNode {
  const frontmatter = parseWikiFrontmatter(page.content);
  const values = frontmatter?.values ?? {};
  const node: WikiGraphNode = {
    path: page.path,
    trustTier: frontmatter ? trustTierFromFrontmatter(frontmatter.body) : "unverified",
  };
  if (values.type) node.type = values.type;
  if (values.title) node.title = values.title;
  if (values.description) node.description = values.description;
  if (values.tags?.startsWith("[")) {
    const tags = parseInlineList(values.tags);
    if (tags.length > 0) node.tags = tags;
  }
  if (values.generated?.startsWith("{")) {
    const generated = parseFlowMapping(values.generated);
    if (generated.by) node.generatedBy = generated.by;
    if (generated.at) node.generatedAt = generated.at;
  }
  return node;
}

/**
 * Derive the cross-link graph for a page set. Pure — callers supply contents
 * (validation reuses what it already read; the server reads the publication).
 */
export function deriveWikiGraph(pages: readonly WikiGraphInputPage[]): WikiGraph {
  const byPath = new Map<string, WikiGraphInputPage>();
  for (const p of pages) {
    byPath.set(p.path.replace(/\\/g, "/"), p);
  }
  const paths = new Set(byPath.keys());

  const nodes: WikiGraphNode[] = [];
  const edges: WikiGraphEdge[] = [];
  const brokenLinks: WikiBrokenLink[] = [];
  const seenEdges = new Set<string>();

  for (const [pagePath, page] of byPath) {
    const reserved = isReservedWikiPath(pagePath);
    if (!reserved) nodes.push(nodeFromPage(page));

    for (const target of extractInternalLinkTargets(page.content)) {
      const resolved = resolveWikiLinkTarget(target, pagePath);
      if (!resolved) {
        brokenLinks.push({ from: pagePath, target });
        continue;
      }
      // Citation namespace: publish rewrites repo: citations under sources/.
      if (resolved === "sources" || resolved.startsWith("sources/")) continue;
      if (!paths.has(resolved)) {
        brokenLinks.push({ from: pagePath, target, resolved });
        continue;
      }
      // Graph edges relate concept pages; listings are navigation, not knowledge.
      if (reserved || isReservedWikiPath(resolved) || resolved === pagePath) continue;
      const key = `${pagePath}\0${resolved}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ from: pagePath, to: resolved });
    }
  }

  return { nodes, edges, brokenLinks };
}

/** Read all `.md` pages under `root` and derive the graph (no symlink follow). */
export async function deriveWikiGraphFromTree(root: string): Promise<WikiGraph> {
  const { pages } = await loadWikiPageRecords(root);
  return deriveWikiGraph(pages.map((page) => ({ path: page.relativePath, content: page.content })));
}
