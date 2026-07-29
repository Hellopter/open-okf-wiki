/**
 * Canonicalize + resolve Source Citations (ADR 0008 page-level grounding).
 *
 * Run-mount tool paths (`sources/<id>/…`) are not citation targets; canonicalize
 * them to the repo-relative contract before resolve / rewrite / staging write-back.
 */

import { lstat, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSourceCitations, type SourceCitation } from "./citations-parse.js";
import { scanWikiTree } from "./wiki-tree.js";

export type CanonicalizeCitationOptions = {
  sourceIds: readonly string[];
  /** true when more than one source */
  multiSource: boolean;
};

export type CanonicalizeCitationResult =
  | { ok: true; target: string }
  | { ok: false; error: string };

/**
 * Canonicalize a citation target to the Skill contract:
 * - single source: bare repository-relative path
 * - multi source: `<sourceId>/<repo-relative path>`
 *
 * Strips run-mount `sources/<registeredId>/…` prefixes. Does not strip a leading
 * `sources/` segment when the next segment is not a registered source id
 * (that path may be a real file under the repository).
 */
export function canonicalizeCitationTarget(
  target: string,
  options: CanonicalizeCitationOptions,
): CanonicalizeCitationResult {
  const raw = target.trim();
  if (!raw) {
    return { ok: false, error: "empty citation path" };
  }
  // Absolute or parent-escape paths are never repository-relative.
  if (raw.startsWith("/") || raw.includes("..")) {
    return {
      ok: false,
      error: `citation path must be repository-relative POSIX (got ${raw})`,
    };
  }

  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return {
      ok: false,
      error: `citation path must be repository-relative POSIX (got ${raw})`,
    };
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { ok: false, error: "empty citation path" };
  }

  const ids = new Set(options.sourceIds);

  // Run-mount form: sources/<registeredId>/rest → strip the mount prefix.
  if (segments[0] === "sources" && segments.length >= 2 && ids.has(segments[1]!)) {
    const id = segments[1]!;
    const rest = segments.slice(2).join("/");
    if (!rest) {
      return {
        ok: false,
        error: `empty citation path after stripping sources/${id}/`,
      };
    }
    return {
      ok: true,
      target: options.multiSource ? `${id}/${rest}` : rest,
    };
  }

  // Explicit source-id prefix with a non-empty rest.
  if (segments.length >= 2 && ids.has(segments[0]!)) {
    const id = segments[0]!;
    const rest = segments.slice(1).join("/");
    if (!rest) {
      return { ok: false, error: `empty citation path after source id ${id}` };
    }
    // Single-source canonical form is bare path (no source-id prefix).
    return {
      ok: true,
      target: options.multiSource ? `${id}/${rest}` : rest,
    };
  }

  // Multi-source requires a registered source-id prefix.
  if (options.multiSource) {
    return {
      ok: false,
      error: `multi-source citation must start with a source id (got ${segments.join("/")})`,
    };
  }

  // Single-source bare path (including real repo paths that start with "sources/"
  // when the next segment is not a registered mount id).
  return { ok: true, target: segments.join("/") };
}

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
  const canon = canonicalizeCitationTarget(citation.target, { sourceIds, multiSource });
  if (!canon.ok) {
    return {
      error:
        `${canon.error} (${citation.raw}); ` +
        "use repo-relative citation targets (not run-mount paths like sources/<id>/…)",
    };
  }

  const target = canon.target;
  const segments = target.split("/").filter(Boolean);
  if (segments.length === 0) {
    return { error: `empty citation path: ${citation.raw}` };
  }

  // Prefer explicit source id prefix when it matches a registered root.
  if (segments.length >= 2 && sources.roots.has(segments[0]!)) {
    const sourceId = segments[0]!;
    const relPath = segments.slice(1).join("/");
    const root = sources.roots.get(sourceId)!;
    return {
      absPath: path.resolve(root, relPath),
      sourceId,
      relPath,
    };
  }

  if (sources.singleRoot) {
    return {
      absPath: path.resolve(sources.singleRoot.path, target),
      sourceId: sources.singleRoot.id,
      relPath: target,
    };
  }

  // Multi-source without matching id prefix (should already fail canonicalize).
  if (sources.roots.size > 1) {
    return {
      error: `multi-source citation must start with a source id: ${citation.raw}`,
    };
  }

  // Single entry in map but singleRoot not set — use the only root.
  if (sources.roots.size === 1) {
    const [sourceId, root] = [...sources.roots.entries()][0]!;
    return {
      absPath: path.resolve(root, target),
      sourceId,
      relPath: target,
    };
  }

  return { error: `cannot resolve citation (no sources): ${citation.raw}` };
}

async function countFileLines(absPath: string): Promise<number> {
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
 */
export async function validateCitationResolve(
  citations: SourceCitation[],
  pageLabel: string,
  sources: SourceRootMap,
): Promise<string[]> {
  if (sources.roots.size === 0 && !sources.singleRoot) {
    return [];
  }
  const errors: string[] = [];
  for (const c of citations) {
    const resolved = resolveCitationFile(c, sources);
    if (resolved === null) {
      continue;
    }
    if ("error" in resolved) {
      errors.push(`${pageLabel}: ${resolved.error}`);
      continue;
    }
    // Containment: resolved path must stay under the source root.
    const root = sources.roots.get(resolved.sourceId) ?? sources.singleRoot?.path;
    if (!root) {
      errors.push(`${pageLabel}: unknown source for ${c.raw}`);
      continue;
    }
    const rootResolved = path.resolve(root);
    if (
      resolved.absPath !== rootResolved &&
      !resolved.absPath.startsWith(rootResolved + path.sep)
    ) {
      errors.push(`${pageLabel}: citation escapes source root (${c.raw})`);
      continue;
    }
    try {
      const st = await lstat(resolved.absPath);
      if (st.isSymbolicLink()) {
        errors.push(`${pageLabel}: citation target is a symlink (${c.raw})`);
        continue;
      }
      if (!st.isFile()) {
        errors.push(`${pageLabel}: citation target is not a file (${c.raw})`);
        continue;
      }
    } catch {
      errors.push(`${pageLabel}: citation target not found in Snapshot (${c.raw})`);
      continue;
    }
    if (c.lineStart !== undefined) {
      try {
        const lineCount = await countFileLines(resolved.absPath);
        const end = c.lineEnd ?? c.lineStart;
        if (c.lineStart > lineCount || end > lineCount) {
          errors.push(
            `${pageLabel}: citation line range out of bounds (${c.raw}; file has ${lineCount} lines)`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${pageLabel}: cannot read citation target (${c.raw}): ${message}`);
      }
    }
  }
  return errors;
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
