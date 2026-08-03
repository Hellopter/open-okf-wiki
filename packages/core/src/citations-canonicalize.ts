/**
 * Canonicalize + resolve Source Citations (ADR 0008 page-level grounding).
 *
 * Target path policy (mount strip, multi-source id prefix, escape rejection)
 * lives in `citation-target.ts` — this module only rewrites content and
 * resolves against Snapshot roots.
 */

import { lstat, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MechanicalIssue } from "@okf-wiki/contract/wiki-runs";
import {
  type CanonicalizeCitationOptions,
  type CanonicalizeCitationResult,
  canonicalizeCitationTarget,
  parseCitationTarget,
} from "./citation-target.js";
import { parseSourceCitations, type SourceCitation } from "./citations-parse.js";
import { makeMechanicalIssue } from "./mechanical-report.js";
import { scanWikiTree } from "./wiki-tree.js";

export type { CanonicalizeCitationOptions, CanonicalizeCitationResult };
export { canonicalizeCitationTarget };

/**
 * Build a Skill-form Source Citation link from a canonical target + optional lines.
 */
export function formatRepoCitation(target: string, lineStart?: number, lineEnd?: number): string {
  let fragment = "";
  if (lineStart !== undefined) {
    if (lineEnd !== undefined && lineEnd !== lineStart) {
      fragment = `#L${lineStart}-L${lineEnd}`;
    } else {
      fragment = `#L${lineStart}`;
    }
  }
  return `[Source](repo:${target}${fragment})`;
}

/**
 * Rewrite all `[Source](repo:…)` citations in page content to canonical targets.
 * Processes matches from end to start so indices stay valid.
 */
export function canonicalizeCitationInContent(
  content: string,
  options: CanonicalizeCitationOptions,
): { content: string; changed: boolean; errors: string[] } {
  const citations = parseSourceCitations(content);
  if (citations.length === 0) {
    return { content, changed: false, errors: [] };
  }

  const ordered = [...citations].sort((a, b) => b.index - a.index);
  let out = content;
  let changed = false;
  const errors: string[] = [];

  for (const c of ordered) {
    const result = canonicalizeCitationTarget(c.target, options);
    if (!result.ok) {
      errors.push(`${result.error} (${c.raw})`);
      continue;
    }
    if (result.target === c.target) {
      continue;
    }
    const next = formatRepoCitation(result.target, c.lineStart, c.lineEnd);
    out = out.slice(0, c.index) + next + out.slice(c.index + c.raw.length);
    changed = true;
  }

  return { content: out, changed, errors };
}

export type CanonicalizeWikiTreeResult = {
  rewrittenPages: number;
  errors: string[];
};

/**
 * Scan a staging wiki tree and rewrite run-mount citation targets on disk.
 * Successful rewrites are written even when some citations fail; failures are
 * collected for the caller (hard-validate will surface remaining bad targets).
 */
export async function canonicalizeWikiTreeCitations(
  wikiRoot: string,
  options: CanonicalizeCitationOptions,
): Promise<CanonicalizeWikiTreeResult> {
  const scan = await scanWikiTree(wikiRoot);
  let rewrittenPages = 0;
  const errors: string[] = [];

  for (const file of scan.files) {
    if (!file.relativePath.toLowerCase().endsWith(".md")) {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(file.absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${file.relativePath}: cannot read page: ${message}`);
      continue;
    }
    const result = canonicalizeCitationInContent(raw, options);
    for (const e of result.errors) {
      errors.push(`${file.relativePath}: ${e}`);
    }
    if (result.changed) {
      await writeFile(file.absolutePath, result.content, "utf8");
      rewrittenPages += 1;
    }
  }

  return { rewrittenPages, errors };
}

export type SourceRootMap = {
  /**
   * sourceId → absolute checkout path.
   * Empty map = format-only checks.
   */
  roots: Map<string, string>;
  /**
   * When the Snapshot Set has exactly one source, bare `repo:path` resolves
   * against this root without requiring a repository-id prefix.
   */
  singleRoot?: { id: string; path: string };
};

/**
 * Resolve citation target to absolute file path under a pinned source root.
 * Returns null when the map is empty (caller should skip resolve).
 *
 * Canonicalizes run-mount / source-id forms before resolve so producers that
 * wrote `sources/<id>/…` still validate against Snapshot roots.
 */
export function resolveCitationFile(
  citation: SourceCitation,
  sources: SourceRootMap,
): { absPath: string; sourceId: string; relPath: string } | { error: string } | null {
  if (sources.roots.size === 0 && !sources.singleRoot) {
    return null;
  }

  const sourceIds =
    sources.roots.size > 0
      ? [...sources.roots.keys()]
      : sources.singleRoot
        ? [sources.singleRoot.id]
        : [];
  const multiSource = sources.roots.size > 1;
  // Sole path policy — no private re-split of the target string.
  const parsed = parseCitationTarget(citation.target, { sourceIds, multiSource });
  if (!parsed.ok) {
    return {
      error:
        `${parsed.error} (${citation.raw}); ` +
        "use repo-relative citation targets (not run-mount paths like sources/<id>/…)",
    };
  }

  const relPath = parsed.repoPath;
  if (!relPath) {
    return { error: `empty citation path: ${citation.raw}` };
  }

  // Prefer explicit / mount-resolved source id when it matches a registered root.
  if (parsed.sourceId && sources.roots.has(parsed.sourceId)) {
    const sourceId = parsed.sourceId;
    const root = sources.roots.get(sourceId)!;
    return {
      absPath: path.resolve(root, relPath),
      sourceId,
      relPath,
    };
  }

  if (sources.singleRoot) {
    return {
      absPath: path.resolve(sources.singleRoot.path, relPath),
      sourceId: sources.singleRoot.id,
      relPath,
    };
  }

  // Multi-source without matching id prefix (should already fail parse).
  if (sources.roots.size > 1) {
    return {
      error: `multi-source citation must start with a source id: ${citation.raw}`,
    };
  }

  // Single entry in map but singleRoot not set — use the only root.
  if (sources.roots.size === 1) {
    const [sourceId, root] = [...sources.roots.entries()][0]!;
    return {
      absPath: path.resolve(root, relPath),
      sourceId,
      relPath,
    };
  }

  return { error: `cannot resolve citation (no sources): ${citation.raw}` };
}

/** Count lines in a text file (handles final line without trailing newline). */
export async function countFileLines(absPath: string): Promise<number> {
  const fh = await open(absPath, "r");
  try {
    let lines = 0;
    let partial = false;
    for await (const chunk of fh.createReadStream({ encoding: "utf8" })) {
      const s = String(chunk);
      for (let i = 0; i < s.length; i++) {
        if (s[i] === "\n") {
          lines += 1;
          partial = false;
        } else {
          partial = true;
        }
      }
    }
    if (partial) {
      lines += 1;
    }
    return lines;
  } finally {
    await fh.close();
  }
}

/**
 * Resolve citations against pinned source roots (file exists + line range in bounds).
 * Returns structured MechanicalIssue rows (no string-code heuristics required).
 */
export async function validateCitationResolve(
  citations: SourceCitation[],
  pageLabel: string,
  sources: SourceRootMap,
): Promise<MechanicalIssue[]> {
  if (sources.roots.size === 0 && !sources.singleRoot) {
    return [];
  }
  const issues: MechanicalIssue[] = [];
  for (const c of citations) {
    const resolved = resolveCitationFile(c, sources);
    if (resolved === null) {
      continue;
    }
    if ("error" in resolved) {
      // resolveCitationFile only fails on target-policy / empty-map cases → format.
      issues.push(
        makeMechanicalIssue({
          code: "citation_format",
          path: pageLabel,
          message: `${pageLabel}: ${resolved.error}`,
          autoFixable: false,
        }),
      );
      continue;
    }
    // Containment: resolved path must stay under the source root.
    const root = sources.roots.get(resolved.sourceId) ?? sources.singleRoot?.path;
    if (!root) {
      issues.push(
        makeMechanicalIssue({
          code: "citation_unresolved",
          path: pageLabel,
          message: `${pageLabel}: unknown source for ${c.raw}`,
          autoFixable: false,
        }),
      );
      continue;
    }
    const rootResolved = path.resolve(root);
    if (
      resolved.absPath !== rootResolved &&
      !resolved.absPath.startsWith(rootResolved + path.sep)
    ) {
      issues.push(
        makeMechanicalIssue({
          code: "citation_format",
          path: pageLabel,
          message: `${pageLabel}: citation escapes source root (${c.raw})`,
          autoFixable: false,
        }),
      );
      continue;
    }
    try {
      const st = await lstat(resolved.absPath);
      if (st.isSymbolicLink()) {
        issues.push(
          makeMechanicalIssue({
            code: "symlink",
            path: pageLabel,
            message: `${pageLabel}: citation target is a symlink (${c.raw})`,
            autoFixable: false,
          }),
        );
        continue;
      }
      if (!st.isFile()) {
        issues.push(
          makeMechanicalIssue({
            code: "citation_unresolved",
            path: pageLabel,
            message: `${pageLabel}: citation target is not a file (${c.raw})`,
            autoFixable: false,
          }),
        );
        continue;
      }
    } catch {
      issues.push(
        makeMechanicalIssue({
          code: "citation_unresolved",
          path: pageLabel,
          message: `${pageLabel}: citation target not found in Snapshot (${c.raw})`,
          autoFixable: false,
        }),
      );
      continue;
    }
    if (c.lineStart !== undefined) {
      try {
        const lineCount = await countFileLines(resolved.absPath);
        const end = c.lineEnd ?? c.lineStart;
        if (c.lineStart > lineCount || end > lineCount) {
          issues.push(
            makeMechanicalIssue({
              code: "citation_oob",
              path: pageLabel,
              message: `${pageLabel}: citation line range out of bounds (${c.raw}; file has ${lineCount} lines)`,
              autoFixable: true,
              fixHint: "clamp_lines",
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push(
          makeMechanicalIssue({
            code: "citation_unresolved",
            path: pageLabel,
            message: `${pageLabel}: cannot read citation target (${c.raw}): ${message}`,
            autoFixable: false,
          }),
        );
      }
    }
  }
  return issues;
}

/**
 * Build SourceRootMap from workspace-like source list.
 */
export function sourceRootMapFromSources(
  sources: Array<{ id: string; path: string }>,
): SourceRootMap {
  const roots = new Map<string, string>();
  for (const s of sources) {
    roots.set(s.id, path.resolve(s.path));
  }
  if (sources.length === 1) {
    return {
      roots,
      singleRoot: {
        id: sources[0]!.id,
        path: path.resolve(sources[0]!.path),
      },
    };
  }
  return { roots };
}
