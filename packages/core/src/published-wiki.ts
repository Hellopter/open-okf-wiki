import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertAbsolutePath,
  assertContainedPathSafe,
  assertNoSymlinkComponents,
  resolveContainedPath,
  resolveExistingDir,
  toPosixRelative,
} from "./paths.js";
import { deriveWikiGraph, type WikiGraph, type WikiGraphInputPage } from "./wiki-links.js";
import { buildWikiNav, type WikiNavNode } from "./wiki-nav.js";
import {
  loadWikiPageRecords,
  parseWikiFrontmatter,
  scanWikiTree,
  WIKI_MAX_FILE_BYTES,
} from "./wiki-tree.js";

/** Soft cap on listed / readable published wiki pages. */
export const PUBLISHED_WIKI_MAX_PAGES = 500;
/** Soft cap on a single published page size (bytes). */
export const PUBLISHED_WIKI_MAX_FILE_BYTES = WIKI_MAX_FILE_BYTES;

export type PublishedWikiPage = {
  /** Relative POSIX path under the publication root (e.g. `overview.md`). */
  path: string;
  content: string;
  /** Non-empty frontmatter title when present. */
  title?: string;
};

export type PublishedWikiErrorCode =
  | "not_found"
  | "empty"
  | "invalid_path"
  | "symlink"
  | "too_large"
  | "io";

/**
 * Structured error for published-wiki list/read helpers.
 * Callers (HTTP layer) map `code` to status codes.
 */
export class PublishedWikiError extends Error {
  readonly code: PublishedWikiErrorCode;

  constructor(code: PublishedWikiErrorCode, message: string) {
    super(message);
    this.name = "PublishedWikiError";
    this.code = code;
  }
}

/**
 * Resolve `relativePath` under publication root via core containment.
 * Rejects empty path / wiki-root-as-file (browse always targets a page).
 */
export function resolvePublishedWikiPath(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new PublishedWikiError("invalid_path", "path must be a non-empty relative path");
  }
  try {
    const resolved = resolveContainedPath(root, relativePath);
    if (path.resolve(resolved) === path.resolve(root)) {
      throw new PublishedWikiError("invalid_path", "path must name a file under the wiki root");
    }
    return resolved;
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      throw error;
    }
    throw new PublishedWikiError(
      "invalid_path",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Convert an absolute path under root to a POSIX-style relative path. */
export function toPublishedWikiPosixRelative(root: string, absolutePath: string): string {
  try {
    const rel = toPosixRelative(root, absolutePath);
    if (rel === ".") {
      throw new PublishedWikiError("invalid_path", "path is outside root");
    }
    return rel;
  } catch (error) {
    if (error instanceof PublishedWikiError) {
      throw error;
    }
    throw new PublishedWikiError(
      "invalid_path",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Symlink-safe check via core {@link assertContainedPathSafe}, mapped to PublishedWikiError.
 */
async function assertPublishedPathSafe(root: string, absolutePath: string): Promise<void> {
  try {
    await assertContainedPathSafe(root, absolutePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/symlink/i.test(message)) {
      throw new PublishedWikiError("symlink", message);
    }
    if (/does not exist|ENOENT/i.test(message)) {
      throw new PublishedWikiError("not_found", message);
    }
    throw new PublishedWikiError("invalid_path", message);
  }
}

/** Absolute existing directory with no symlink components (published wiki root). */
async function assertPublicationRoot(publicationPath: string): Promise<string> {
  let absolute: string;
  try {
    absolute = path.resolve(assertAbsolutePath(publicationPath, "publicationPath"));
  } catch (error) {
    throw new PublishedWikiError(
      "invalid_path",
      error instanceof Error ? error.message : String(error),
    );
  }

  let resolved: string;
  try {
    resolved = await resolveExistingDir(absolute);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist/i.test(message)) {
      throw new PublishedWikiError("not_found", `publication path does not exist: ${absolute}`);
    }
    if (/not a directory/i.test(message)) {
      throw new PublishedWikiError(
        "invalid_path",
        `publicationPath is not a directory: ${absolute}`,
      );
    }
    throw new PublishedWikiError("io", message);
  }

  try {
    await assertNoSymlinkComponents(resolved, "publicationPath");
  } catch (error) {
    throw new PublishedWikiError("symlink", error instanceof Error ? error.message : String(error));
  }

  return resolved;
}

/**
 * Recursively list `.md` files under `publicationPath` as relative POSIX paths.
 * Sorted lexicographically. Does not follow symlinks.
 *
 * @throws {PublishedWikiError} `not_found` if missing, `empty` if no markdown pages.
 */
export async function listPublishedWikiPages(publicationPath: string): Promise<string[]> {
  const root = await assertPublicationRoot(publicationPath);
  const scan = await scanWikiTree(root);
  const ioIssue = scan.issues.find((issue) => issue.kind === "io");
  if (ioIssue) {
    throw new PublishedWikiError("io", ioIssue.message);
  }
  const pages = scan.files
    .filter((file) => file.relativePath.toLowerCase().endsWith(".md"))
    .map((file) => file.relativePath);

  if (pages.length > PUBLISHED_WIKI_MAX_PAGES) {
    throw new PublishedWikiError(
      "too_large",
      `published wiki has more than ${PUBLISHED_WIKI_MAX_PAGES} pages`,
    );
  }

  if (pages.length === 0) {
    throw new PublishedWikiError("empty", `published wiki has no markdown pages: ${root}`);
  }

  pages.sort((a, b) => a.localeCompare(b));
  return pages;
}

export type PublishedWikiPageSummary = {
  /** Relative POSIX path under the publication root. */
  path: string;
  /** Frontmatter metadata when present (concept pages). */
  type?: string;
  title?: string;
  description?: string;
};

/** Read all published pages once (list rules + per-file size cap applied). */
async function readAllPublishedPages(
  publicationPath: string,
): Promise<Array<WikiGraphInputPage & { summary: PublishedWikiPageSummary }>> {
  const root = await assertPublicationRoot(publicationPath);
  const { pages, scan } = await loadWikiPageRecords(root, {
    maxFileBytes: PUBLISHED_WIKI_MAX_FILE_BYTES,
  });
  const ioIssue = scan.issues.find((issue) => issue.kind === "io");
  if (ioIssue) {
    throw new PublishedWikiError("io", ioIssue.message);
  }

  const mdCount = scan.files.filter((file) =>
    file.relativePath.toLowerCase().endsWith(".md"),
  ).length;
  if (mdCount > PUBLISHED_WIKI_MAX_PAGES) {
    throw new PublishedWikiError(
      "too_large",
      `published wiki has more than ${PUBLISHED_WIKI_MAX_PAGES} pages`,
    );
  }
  if (mdCount === 0) {
    throw new PublishedWikiError("empty", `published wiki has no markdown pages: ${root}`);
  }

  // Oversized / unreadable files are omitted (same as prior silent skip).
  return pages.map((page) => {
    const summary: PublishedWikiPageSummary = { path: page.relativePath };
    if (page.values.type) summary.type = page.values.type;
    if (page.values.title) summary.title = page.values.title;
    if (page.values.description) summary.description = page.values.description;
    return { path: page.relativePath, content: page.content, summary };
  });
}

export type PublishedWikiBrowse = {
  /** Relative POSIX paths (lexicographic), including reserved files. */
  pages: string[];
  summaries: PublishedWikiPageSummary[];
  /** Index-ordered reader TOC (concept pages only). */
  nav: WikiNavNode[];
};

/**
 * One-shot browse payload: summaries + index-aware navigation tree.
 * Prefer this over separate list + client-side path trees.
 */
export async function listPublishedWikiBrowse(
  publicationPath: string,
): Promise<PublishedWikiBrowse> {
  const loaded = await readAllPublishedPages(publicationPath);
  const summaries = loaded.map((page) => page.summary);
  const nav = buildWikiNav(
    loaded.map((page) => ({
      path: page.path,
      content: page.content,
      ...(page.summary.title ? { title: page.summary.title } : {}),
      ...(page.summary.type ? { type: page.summary.type } : {}),
    })),
  );
  return {
    pages: summaries.map((s) => s.path),
    summaries,
    nav,
  };
}

/**
 * Derive the published Wiki cross-link graph (Wiki Visualization source data):
 * concept nodes with metadata, directed edges from internal links, broken links.
 */
export async function derivePublishedWikiGraph(publicationPath: string): Promise<WikiGraph> {
  return deriveWikiGraph(await readAllPublishedPages(publicationPath));
}

/**
 * Read one markdown page under `publicationPath`.
 * `relativePath` must be a relative path with no `..` segments.
 *
 * @throws {PublishedWikiError} on escape, missing file, symlink, or size cap.
 */
export async function readPublishedWikiPage(
  publicationPath: string,
  relativePath: string,
): Promise<PublishedWikiPage> {
  const root = await assertPublicationRoot(publicationPath);
  const abs = resolvePublishedWikiPath(root, relativePath);
  await assertPublishedPathSafe(root, abs);

  let info;
  try {
    info = await lstat(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new PublishedWikiError("not_found", `page not found: ${relativePath}`);
    }
    throw new PublishedWikiError("io", error instanceof Error ? error.message : String(error));
  }

  if (info.isSymbolicLink()) {
    throw new PublishedWikiError("symlink", `path is a symlink: ${relativePath}`);
  }
  if (!info.isFile()) {
    throw new PublishedWikiError("invalid_path", `path is not a file: ${relativePath}`);
  }
  if (!abs.toLowerCase().endsWith(".md")) {
    throw new PublishedWikiError("invalid_path", `path is not a markdown file: ${relativePath}`);
  }
  if (info.size > PUBLISHED_WIKI_MAX_FILE_BYTES) {
    throw new PublishedWikiError(
      "too_large",
      `page exceeds max size (${info.size} > ${PUBLISHED_WIKI_MAX_FILE_BYTES} bytes)`,
    );
  }

  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch (error) {
    throw new PublishedWikiError(
      "io",
      `cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const posixPath = toPublishedWikiPosixRelative(root, abs);
  const title = parseWikiFrontmatter(content)?.values.title;
  const page: PublishedWikiPage = { path: posixPath, content };
  if (title !== undefined) {
    page.title = title;
  }
  return page;
}
