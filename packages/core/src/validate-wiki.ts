import { lstat } from "node:fs/promises";
import path from "node:path";
import {
  parseSourceCitations,
  type SourceRootMap,
  sourceRootMapFromSources,
  validateCitationFormat,
  validateCitationResolve,
} from "./citations.js";
import { assertAbsolutePath, assertNoSymlinkComponents } from "./paths.js";
import { deriveWikiGraph } from "./wiki-links.js";
import {
  isReservedWikiPath,
  loadWikiPageRecords,
  WIKI_MAX_FILE_BYTES,
} from "./wiki-tree.js";

/** Soft caps for mechanical publication validation. */
export const WIKI_VALIDATE_MAX_FILES = 500;
export const WIKI_VALIDATE_MAX_FILE_BYTES = WIKI_MAX_FILE_BYTES;

export type ValidateWikiOptions = {
  /**
   * Pinned Repository Snapshot roots for Source Citation resolve (ADR 0008).
   * When omitted, only citation *format* is checked (and pages need ≥1 citation).
   */
  sources?: Array<{ id: string; path: string }>;
  /**
   * When true (default), every `.md` page must contain at least one Source Citation.
   */
  requireCitations?: boolean;
};

export type ValidateWikiResult = {
  ok: boolean;
  errors: string[];
  /**
   * Non-blocking quality notes (OKF SHOULDs, e.g. missing `description`).
   * Never affect `ok` — OKF consumers must not reject on optional fields.
   */
  warnings: string[];
  /** Count of `.md` pages found when walk succeeded far enough. */
  pageCount?: number;
  /** Total files walked (md + non-md), when available. */
  fileCount?: number;
  /** Total Source Citations found across pages. */
  citationCount?: number;
};

/**
 * Mechanically validate a staging / publication-candidate Wiki tree before publish.
 *
 * Checks:
 * - Absolute path, real directory, no symlink components
 * - At least one `.md` file
 * - Concept `.md` pages: YAML frontmatter with non-empty `type` + `title` (OKF + product)
 * - Reserved `index.md` / `log.md`: exempt from concept frontmatter and citations
 * - Source Citations on concept pages (format + optional Snapshot resolve) — ADR 0008
 * - No symlinks inside the tree
 * - Soft caps: ≤ {@link WIKI_VALIDATE_MAX_FILES} files, each ≤ 1MB
 */
export async function validateWikiTree(
  dir: string,
  options: ValidateWikiOptions = {},
): Promise<ValidateWikiResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Citations required when Snapshot sources are supplied (publish path) unless
  // explicitly disabled. Pure frontmatter/caps checks omit sources.
  // Reserved OKF files (index.md / log.md) never require citations.
  const requireCitations = options.requireCitations ?? Boolean(options.sources?.length);
  const sourceMap: SourceRootMap | undefined = options.sources
    ? sourceRootMapFromSources(options.sources)
    : undefined;
  let citationCount = 0;

  let resolved: string;
  try {
    resolved = path.resolve(assertAbsolutePath(dir, "wikiDir"));
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  let rootInfo;
  try {
    rootInfo = await lstat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { ok: false, errors: [`wiki directory does not exist: ${resolved}`], warnings };
    }
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  if (rootInfo.isSymbolicLink()) {
    return { ok: false, errors: [`wikiDir is a symlink: ${resolved}`], warnings };
  }
  if (!rootInfo.isDirectory()) {
    return { ok: false, errors: [`wikiDir is not a directory: ${resolved}`], warnings };
  }

  try {
    await assertNoSymlinkComponents(resolved, "wikiDir");
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  const { pages, scan, loadIssues } = await loadWikiPageRecords(resolved, {
    maxFileBytes: WIKI_VALIDATE_MAX_FILE_BYTES,
  });
  errors.push(...scan.issues.map((issue) => issue.message));
  errors.push(...loadIssues.map((issue) => issue.message));

  const fileCount = scan.files.length;
  const pageCount = scan.files.filter((file) =>
    file.relativePath.toLowerCase().endsWith(".md"),
  ).length;

  if (fileCount > WIKI_VALIDATE_MAX_FILES) {
    errors.push(`wiki tree has ${fileCount} files (max ${WIKI_VALIDATE_MAX_FILES})`);
  }

  if (pageCount < 1) {
    errors.push(`wiki tree has no markdown pages: ${resolved}`);
  }

  for (const page of pages) {
    const reserved = isReservedWikiPath(page.relativePath);
    if (reserved) {
      // OKF reserved listing/history files: no concept frontmatter or citations.
      continue;
    }
    const hasType = Boolean(page.values.type);
    const hasTitle = Boolean(page.values.title);
    if (!hasType || !hasTitle) {
      if (!hasType && !hasTitle) {
        errors.push(
          `${page.relativePath}: missing YAML frontmatter with non-empty type and title`,
        );
      } else if (!hasType) {
        errors.push(`${page.relativePath}: missing YAML frontmatter with non-empty type`);
      } else {
        errors.push(`${page.relativePath}: missing YAML frontmatter with non-empty title`);
      }
    }
    // OKF v0.2 SHOULD: description feeds index generation, search, and previews.
    if (page.hasFrontmatter && !page.values.description) {
      warnings.push(`${page.relativePath}: missing frontmatter description (OKF v0.2 recommended)`);
    }
    const citations = parseSourceCitations(page.content);
    citationCount += citations.length;
    if (requireCitations && citations.length === 0) {
      errors.push(`${page.relativePath}: missing Source Citation ([Source](repo:…#L…))`);
    }
    errors.push(...validateCitationFormat(citations, page.relativePath));
    if (sourceMap) {
      errors.push(...(await validateCitationResolve(citations, page.relativePath, sourceMap)));
    }
  }

  // Broken internal links are quality notes, never rejection (OKF §6.1: a
  // missing target may be not-yet-written knowledge).
  for (const broken of deriveWikiGraph(
    pages.map((page) => ({ path: page.relativePath, content: page.content })),
  ).brokenLinks) {
    warnings.push(`${broken.from}: broken internal link (${broken.target})`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pageCount,
    fileCount,
    citationCount,
  };
}
