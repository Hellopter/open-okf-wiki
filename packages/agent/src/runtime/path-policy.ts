/**
 * Pure path policy for a run workdir (ADR 0030).
 *
 *   sources/  — snapshot mounts (read-only)
 *   skill/    — Producer Skill (read-only)
 *   wiki/     — Staging Wiki (writable for write roles)
 *   analysis/ — spec + receipts (writable for write roles)
 *
 * No filesystem I/O — policy is unit-tested without node:fs.
 */

import path from "node:path";
import { isPathInside, pathMatchesIgnore, resolveContainedPath } from "@okf-wiki/core";

/** Relative trees writable by write roles (trailing slash for prefix match). */
export const WRITE_SCOPE_PREFIXES = ["wiki/", "analysis/"] as const;

/** Relative trees that are never writable. */
export const READ_ONLY_PREFIXES = ["sources/", "skill/"] as const;

export type PathAccessMode = "read" | "write";

export type SourceIgnoreInput = ReadonlyMap<string, readonly string[]> | readonly string[];

export type AssertPathAllowedOptions = {
  mode: PathAccessMode;
  /**
   * Optional Effective Source Ignores applied when the path is under sources/.
   * - Map: per-sourceId patterns (repo-relative POSIX globs)
   * - Array: same patterns for every source mount
   */
  sourceIgnores?: SourceIgnoreInput;
  /**
   * Workdir-relative trees denied for every access mode (e.g. `.okf-wiki`
   * for Operator Sessions, whose scope root is the Workspace rootPath —
   * product meta holds Pi agentDir settings/auth and must stay unreadable).
   */
  denyPrefixes?: readonly string[];
};

/** True when a workdir-relative path is inside any denied tree. */
export function isDeniedRel(relPath: string, denyPrefixes: readonly string[] | undefined): boolean {
  if (!denyPrefixes || denyPrefixes.length === 0) return false;
  const n = normalizeRelPath(relPath);
  if (!n) return false;
  return denyPrefixes.some((prefix) => {
    const p = normalizeRelPath(prefix);
    return p !== "" && (n === p || n.startsWith(`${p}/`));
  });
}

/**
 * True if `candidate` is `dir` or a path strictly inside it
 * (resolved absolute comparison).
 */
export function isUnder(dir: string, candidate: string): boolean {
  return isPathInside(dir, candidate);
}

/** Normalize a workdir-relative path to POSIX segments without leading `./`. */
export function normalizeRelPath(relPath: string): string {
  if (typeof relPath !== "string") {
    throw new Error("path must be a string");
  }
  let n = relPath.trim().replace(/\\/g, "/");
  while (n.startsWith("./")) {
    n = n.slice(2);
  }
  if (n === "." || n === "") {
    return "";
  }
  // Strip trailing slash except for pure roots we don't use here.
  if (n.length > 1 && n.endsWith("/")) {
    n = n.slice(0, -1);
  }
  return n;
}

/**
 * True when a run-workdir-relative path is inside the write scope
 * (`wiki/**` or `analysis/**`).
 */
export function isWriteScopeRel(relPath: string): boolean {
  const n = normalizeRelPath(relPath);
  if (n === "wiki" || n === "analysis") {
    return true;
  }
  return n.startsWith("wiki/") || n.startsWith("analysis/");
}

/** True when path is under sources/ or skill/ (read-only trees). */
export function isReadOnlyTreeRel(relPath: string): boolean {
  const n = normalizeRelPath(relPath);
  if (n === "sources" || n === "skill") {
    return true;
  }
  return n.startsWith("sources/") || n.startsWith("skill/");
}

/**
 * Parse `sources/<id>/...` into source id + repo-relative path.
 * Returns null when not under sources/.
 */
export function parseSourceMountPath(
  relPath: string,
): { sourceId: string; repoRel: string } | null {
  const n = normalizeRelPath(relPath);
  if (n === "sources") {
    return null;
  }
  if (!n.startsWith("sources/")) {
    return null;
  }
  const rest = n.slice("sources/".length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    // sources/<id> (mount root itself)
    return { sourceId: rest, repoRel: "" };
  }
  return {
    sourceId: rest.slice(0, slash),
    repoRel: rest.slice(slash + 1),
  };
}

function patternsForSource(
  sourceId: string,
  sourceIgnores: SourceIgnoreInput | undefined,
): readonly string[] | undefined {
  if (!sourceIgnores) {
    return undefined;
  }
  if (Array.isArray(sourceIgnores)) {
    return sourceIgnores;
  }
  const map = sourceIgnores as ReadonlyMap<string, readonly string[]>;
  return map.get(sourceId);
}

/**
 * True when a run-workdir-relative path under sources/ matches Effective Source Ignores.
 * Paths outside sources/ (or empty ignore list) are never ignored by this helper.
 */
export function isIgnoredSourceRel(
  relPath: string,
  sourceIgnores: SourceIgnoreInput | undefined,
): boolean {
  if (!sourceIgnores) {
    return false;
  }
  const parsed = parseSourceMountPath(relPath);
  if (!parsed || !parsed.repoRel) {
    return false;
  }
  const patterns = patternsForSource(parsed.sourceId, sourceIgnores);
  if (!patterns || patterns.length === 0) {
    return false;
  }
  return pathMatchesIgnore(parsed.repoRel, patterns);
}

/**
 * Assert that `relPath` is allowed under `runWorkDir` for the given access mode.
 * Returns the resolved absolute path on success; throws on denial.
 */
export function assertPathAllowed(
  runWorkDir: string,
  relPath: string,
  options: AssertPathAllowedOptions,
): string {
  if (typeof runWorkDir !== "string" || runWorkDir.trim() === "") {
    throw new Error("runWorkDir must be a non-empty absolute path");
  }
  const root = path.resolve(runWorkDir);
  const abs = resolveContainedPath(root, relPath ?? "");
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  const norm = rel === "" ? "" : normalizeRelPath(rel);

  if (norm && isDeniedRel(norm, options.denyPrefixes)) {
    throw new Error(`${options.mode} denied: path is product-reserved (${norm})`);
  }

  if (options.mode === "write") {
    if (!norm) {
      throw new Error("write path must be under wiki/ or analysis/");
    }
    if (isReadOnlyTreeRel(norm)) {
      throw new Error(`write denied: sources/ and skill/ are read-only (${norm})`);
    }
    if (!isWriteScopeRel(norm)) {
      throw new Error(`write denied: path must be under wiki/ or analysis/ (got ${norm})`);
    }
    return abs;
  }

  // read
  if (norm && isIgnoredSourceRel(norm, options.sourceIgnores)) {
    throw new Error(`read denied: path is ignored by Source Ignores (${norm})`);
  }
  return abs;
}

/**
 * Same policy as {@link assertPathAllowed}, but for absolute paths already
 * resolved by Pi tools (Operations receive absolute paths).
 */
export function assertAbsolutePathAllowed(
  runWorkDir: string,
  absolutePath: string,
  options: AssertPathAllowedOptions,
): string {
  const root = path.resolve(runWorkDir);
  const abs = path.resolve(absolutePath);
  if (!isUnder(root, abs)) {
    throw new Error(`path escapes run workdir: ${absolutePath}`);
  }
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  return assertPathAllowed(root, rel === "" ? "." : rel, options);
}
