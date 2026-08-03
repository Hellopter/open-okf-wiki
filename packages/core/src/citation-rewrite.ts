/**
 * Publish-time rewrite: staging keeps [Source](repo:…) for validation;
 * published wiki gets portable relative links under a sources/ convention.
 *
 * From page `modules/foo.md` + single-source target `README.md`:
 *   [Source](../sources/<id>/README.md#L1-L2)
 *
 * Portable layout (optional sibling of publication root):
 *   publication/
 *     overview.md
 *     modules/…
 *   sources/<id>/…   ← not always shipped; links remain standard Markdown
 */

import path from "node:path";
import { parseCitationTarget } from "./citation-target.js";
import { parseSourceCitations, type SourceCitation } from "./citations-parse.js";

export type CitationRewriteSources = Array<{ id: string }>;

export type RewriteRepoCitationsOptions = {
  /**
   * Relative POSIX path of this page under the wiki/publication root
   * (e.g. `overview.md`, `modules/runtime.md`).
   */
  pageRelPath: string;
  /** Snapshot source ids (order irrelevant). */
  sources: CitationRewriteSources;
};

function lineFragment(c: SourceCitation): string {
  if (c.lineStart === undefined) return "";
  if (c.lineEnd !== undefined && c.lineEnd !== c.lineStart) {
    return `#L${c.lineStart}-L${c.lineEnd}`;
  }
  return `#L${c.lineStart}`;
}

/**
 * Relative href from the page file to `sources/<id>/<relPath>` under the
 * publication root (wiki files at root of that tree).
 */
export function relativeSourceHref(
  pageRelPath: string,
  sourceId: string,
  relPathInSource: string,
): string {
  const page = pageRelPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const pageDir = path.posix.dirname(page);
  const fromDir = pageDir === "." ? "" : pageDir;
  const targetFromRoot = path.posix.join("sources", sourceId, relPathInSource.replace(/\\/g, "/"));
  const rel = path.posix.relative(fromDir || ".", targetFromRoot);
  // path.posix.relative never yields empty for distinct paths; keep stable.
  return rel || targetFromRoot;
}

export function rewriteOneRepoCitation(
  citation: SourceCitation,
  options: RewriteRepoCitationsOptions,
): string | null {
  const parsed = parseCitationTarget(citation.target, {
    sourceIds: options.sources.map((s) => s.id),
    multiSource: options.sources.length > 1,
  });
  // Need a bound source id to place under sources/<id>/…
  if (!parsed.ok || !parsed.sourceId) return null;
  const href =
    relativeSourceHref(options.pageRelPath, parsed.sourceId, parsed.repoPath) +
    lineFragment(citation);
  return `[Source](${href})`;
}

/**
 * Replace all Skill-form `[Source](repo:…)` citations with portable relative links.
 * Unresolvable multi-source bare paths are left unchanged.
 */
export function rewriteRepoCitationsToRelative(
  content: string,
  options: RewriteRepoCitationsOptions,
): string {
  if (!options.sources.length) return content;
  const citations = parseSourceCitations(content);
  if (citations.length === 0) return content;

  // Replace from the end so indices stay valid.
  const ordered = [...citations].sort((a, b) => b.index - a.index);
  let out = content;
  for (const c of ordered) {
    const next = rewriteOneRepoCitation(c, options);
    if (!next) continue;
    out = out.slice(0, c.index) + next + out.slice(c.index + c.raw.length);
  }
  return out;
}
