import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Soft cap on a single wiki markdown file size (bytes) for read / validate paths. */
export const WIKI_MAX_FILE_BYTES = 1_000_000;

/** UTF-8 BOM, kept out of string literals so the file has no invisible chars. */
const BOM = String.fromCharCode(0xfeff);

/** Closing fence: `---` plus only spaces/tabs (not arbitrary `\s`). */
const FRONTMATTER_CLOSE_RE = /^---[ \t]*$/m;

export type WikiFrontmatter = {
  /** Frontmatter inner text (no opening/closing fences). */
  body: string;
  values: Readonly<Record<string, string>>;
};

export type WikiFrontmatterSplit = {
  /** BOM prefix when present, re-emitted verbatim by writers. */
  bom: string;
  /** Frontmatter inner lines (no delimiters); trailing newline before close stripped. */
  inner: string;
  /** Content after the closing delimiter match (leading newline preserved). */
  rest: string;
  values: Readonly<Record<string, string>>;
};

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" ? parsed.trim() : "";
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterValues(inner: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of inner.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = unquoteYamlScalar(match[2]!);
    if (value) values[match[1]!.toLowerCase()] = value;
  }
  return Object.freeze(values);
}

/**
 * Split markdown into optional BOM, frontmatter inner block, body rest, and
 * simple key:value scalars. Single primitive for stamp / parse / strip.
 */
export function splitWikiFrontmatter(content: string): WikiFrontmatterSplit | null {
  const bom = content.startsWith(BOM) ? BOM : "";
  const withoutBom = bom ? content.slice(1) : content;
  const firstNewline = withoutBom.indexOf("\n");
  if (firstNewline < 0 || withoutBom.slice(0, firstNewline).trim() !== "---") {
    return null;
  }
  const afterOpen = withoutBom.slice(firstNewline + 1);
  const closeMatch = FRONTMATTER_CLOSE_RE.exec(afterOpen);
  if (!closeMatch) {
    return null;
  }
  const inner = afterOpen.slice(0, closeMatch.index).replace(/\r?\n$/, "");
  const rest = afterOpen.slice(closeMatch.index + closeMatch[0].length);
  return { bom, inner, rest, values: parseFrontmatterValues(inner) };
}

/** Parse the bounded frontmatter subset used by validation and Wiki browsing. */
export function parseWikiFrontmatter(content: string): WikiFrontmatter | null {
  const split = splitWikiFrontmatter(content);
  if (!split) return null;
  return { body: split.inner, values: split.values };
}

/**
 * Markdown body after a frontmatter block, or the full content (BOM stripped)
 * when no parseable frontmatter is present.
 */
export function wikiMarkdownBody(content: string): string {
  const split = splitWikiFrontmatter(content);
  if (!split) {
    return content.startsWith(BOM) ? content.slice(1) : content;
  }
  return split.rest.replace(/^\r?\n/, "");
}

export type WikiTreeFile = {
  absolutePath: string;
  /** POSIX path relative to the scanned root. */
  relativePath: string;
  size: number;
};

export type WikiTreeIssue = {
  kind: "io" | "symlink" | "special";
  relativePath: string;
  message: string;
  code?: string;
};

export type WikiTreeScan = {
  files: WikiTreeFile[];
  issues: WikiTreeIssue[];
};

/** Stable depth-first scan that never follows symlinks. */
export async function scanWikiTree(root: string): Promise<WikiTreeScan> {
  const resolvedRoot = path.resolve(root);
  const files: WikiTreeFile[] = [];
  const issues: WikiTreeIssue[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      issues.push({
        kind: "io",
        relativePath: relativeDirectory || ".",
        message: `cannot read directory ${relativeDirectory || "."}: ${error instanceof Error ? error.message : String(error)}`,
        ...((error as NodeJS.ErrnoException | undefined)?.code
          ? { code: (error as NodeJS.ErrnoException).code }
          : {}),
      });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        issues.push({
          kind: "io",
          relativePath,
          message: `cannot stat ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
          ...((error as NodeJS.ErrnoException | undefined)?.code
            ? { code: (error as NodeJS.ErrnoException).code }
            : {}),
        });
        continue;
      }

      if (info.isSymbolicLink()) {
        issues.push({
          kind: "symlink",
          relativePath,
          message: `symlink not allowed in wiki tree: ${relativePath}`,
        });
      } else if (info.isDirectory()) {
        await walk(absolutePath, relativePath);
      } else if (info.isFile()) {
        files.push({ absolutePath, relativePath, size: info.size });
      } else {
        issues.push({
          kind: "special",
          relativePath,
          message: `non-regular entry not allowed in wiki tree: ${relativePath}`,
        });
      }
    }
  }

  await walk(resolvedRoot, "");
  return { files, issues };
}

/** Count Markdown files using the same no-follow traversal as all Wiki readers. */
export async function countMarkdownFiles(root: string): Promise<number> {
  const scan = await scanWikiTree(root);
  const missingRoot = scan.issues.some(
    (issue) => issue.kind === "io" && issue.relativePath === "." && issue.code === "ENOENT",
  );
  if (missingRoot) return 0;
  const ioIssue = scan.issues.find((issue) => issue.kind === "io");
  if (ioIssue) throw new Error(ioIssue.message);
  return scan.files.filter((file) => file.relativePath.toLowerCase().endsWith(".md")).length;
}

/** One markdown page loaded after {@link scanWikiTree} (content + optional frontmatter). */
export type WikiPageRecord = {
  absolutePath: string;
  /** POSIX path relative to the scanned root. */
  relativePath: string;
  content: string;
  size: number;
  /** True when a parseable frontmatter block was present. */
  hasFrontmatter: boolean;
  /** Frontmatter scalars when present; empty object when absent / unparseable. */
  values: Readonly<Record<string, string>>;
};

export type WikiPageLoadIssue = {
  relativePath: string;
  kind: "size" | "symlink" | "special" | "io";
  message: string;
};

export type LoadWikiPageRecordsOptions = {
  /**
   * When set, files larger than this many bytes are not read and appear in
   * {@link LoadWikiPageRecordsResult.loadIssues}.
   */
  maxFileBytes?: number;
};

export type LoadWikiPageRecordsResult = {
  pages: WikiPageRecord[];
  scan: WikiTreeScan;
  /** Per-file load failures (size cap, TOCTOU symlink, read I/O). */
  loadIssues: WikiPageLoadIssue[];
};

/**
 * Shared post-scan projection: markdown files under `root` with content and
 * frontmatter. Uses {@link scanWikiTree} (no second walk), re-lstats before
 * read (symlink race), and never follows links.
 */
export async function loadWikiPageRecords(
  root: string,
  options: LoadWikiPageRecordsOptions = {},
): Promise<LoadWikiPageRecordsResult> {
  const scan = await scanWikiTree(root);
  const pages: WikiPageRecord[] = [];
  const loadIssues: WikiPageLoadIssue[] = [];
  const { maxFileBytes } = options;

  for (const file of scan.files) {
    const relativePath = file.relativePath.replace(/\\/g, "/");
    if (!relativePath.toLowerCase().endsWith(".md")) continue;

    let size: number;
    try {
      // Re-lstat: never follow a symlink swapped in after the walk.
      const info = await lstat(file.absolutePath);
      if (info.isSymbolicLink()) {
        loadIssues.push({
          relativePath,
          kind: "symlink",
          message: `symlink not allowed in wiki tree: ${relativePath}`,
        });
        continue;
      }
      if (!info.isFile()) {
        loadIssues.push({
          relativePath,
          kind: "special",
          message: `not a regular file: ${relativePath}`,
        });
        continue;
      }
      size = info.size;
    } catch (error) {
      loadIssues.push({
        relativePath,
        kind: "io",
        message: `cannot stat ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (maxFileBytes !== undefined && size > maxFileBytes) {
      loadIssues.push({
        relativePath,
        kind: "size",
        message: `${relativePath} exceeds max file size (${size} > ${maxFileBytes} bytes)`,
      });
      continue;
    }

    let content: string;
    try {
      content = await readFile(file.absolutePath, "utf8");
    } catch (error) {
      loadIssues.push({
        relativePath,
        kind: "io",
        message: `cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const frontmatter = parseWikiFrontmatter(content);
    pages.push({
      absolutePath: file.absolutePath,
      relativePath,
      content,
      size,
      hasFrontmatter: frontmatter !== null,
      values: frontmatter?.values ?? Object.freeze({}),
    });
  }

  return { pages, scan, loadIssues };
}

/** Reserved OKF listing/history filenames, not concept pages. */
export const RESERVED_WIKI_BASENAMES = new Set(["index.md", "log.md"]);

export function isReservedWikiPath(relativePath: string): boolean {
  const basename = relativePath.split("/").pop()?.toLowerCase() ?? "";
  return RESERVED_WIKI_BASENAMES.has(basename);
}
