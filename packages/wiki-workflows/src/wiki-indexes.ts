import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { inside, readText, writeText } from "./files.js";
import { parsePage } from "./frontmatter.js";
import type { WikiValidationIssue } from "./types.js";
import type { WikiSpec } from "./workflow-types.js";
import {
  derivedIndexPaths,
  formatIssue,
  isMissing,
  issue,
  removeRegularWikiFile,
  resolveWikiRoots,
  safeWikiPath,
  scanWikiTree,
  specPagePaths,
  type ResolvedWikiRoots,
} from "./wiki-validate.js";

/** Replace the deterministic index projection without modifying concept pages. */
export async function materializeWikiIndexes(root: string, spec: WikiSpec, wikiDirectory = "wiki"): Promise<string[]> {
  const specIssues: WikiValidationIssue[] = [];
  const targetPages = specPagePaths(spec, specIssues);
  if (specIssues.length) throw new Error(`Cannot materialize Wiki indexes: ${specIssues.map(formatIssue).join("; ")}`);

  const roots = await resolveWikiRoots(root, wikiDirectory);
  const tree = await scanWikiTree(roots.wiki);
  if (tree.issues.length) throw new Error(`Unsafe Wiki tree: ${tree.issues.map(formatIssue).join("; ")}`);

  // Read every page before replacing indexes so a malformed page cannot leave a partial projection.
  for (const page of targetPages) {
    const parsed = parsePage(await readText(safeWikiPath(roots.wiki, page)));
    if (!normalizeIndexText(parsed.frontmatter.title) || !normalizeIndexText(parsed.frontmatter.description)) {
      throw new Error(`Cannot materialize Wiki index from invalid page metadata: ${page}`);
    }
  }

  for (const indexPath of tree.markdown.filter((page) => path.posix.basename(page) === "index.md")) {
    await removeRegularWikiFile(roots.wiki, indexPath);
  }
  const rebuiltIndexes = derivedIndexPaths(targetPages);
  for (const indexPath of rebuiltIndexes) {
    await writeWikiIndex(roots.wiki, indexPath, targetPages, rebuiltIndexes, spec, roots.language);
  }
  return rebuiltIndexes;
}

export async function validateWikiIndexes(
  roots: ResolvedWikiRoots,
  spec: WikiSpec,
  targetPages: readonly string[],
  indexablePages: ReadonlySet<string>,
  markdown: readonly string[],
  issues: WikiValidationIssue[],
): Promise<void> {
  const expectedIndexes = derivedIndexPaths(targetPages);
  const expectedSet = new Set(expectedIndexes);
  const actualIndexes = markdown.filter((page) => path.posix.basename(page) === "index.md");
  const actualSet = new Set(actualIndexes);

  for (const indexPath of expectedIndexes) {
    if (!actualSet.has(indexPath)) issue(issues, "wiki-index", `Required Wiki index is missing: ${indexPath}`, indexPath);
  }
  for (const indexPath of actualIndexes) {
    if (!expectedSet.has(indexPath)) issue(issues, "wiki-index", `Unexpected Wiki index is present: ${indexPath}`, indexPath);
  }
  for (const indexPath of expectedIndexes) {
    if (!actualSet.has(indexPath)) continue;
    const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
    const directPages = targetPages.filter(
      (page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory,
    );
    if (directPages.some((page) => !indexablePages.has(page))) continue;
    const expected = await renderWikiIndex(roots.wiki, indexPath, targetPages, expectedIndexes, spec, roots.language);
    const actual = await readText(safeWikiPath(roots.wiki, indexPath));
    if (actual !== expected) {
      issue(issues, "wiki-index", `Wiki index does not match the deterministic OKF projection: ${indexPath}`, indexPath);
    }
  }
}

async function writeWikiIndex(
  wikiRoot: string,
  indexPath: string,
  targetPages: readonly string[],
  targetIndexes: readonly string[],
  spec: WikiSpec,
  language: "zh" | "en",
): Promise<void> {
  const absolute = safeWikiPath(wikiRoot, indexPath);
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const directory = relativeDirectory ? safeWikiPath(wikiRoot, relativeDirectory) : wikiRoot;
  await mkdir(directory, { recursive: true });
  await assertSafeDirectoryChain(wikiRoot, relativeDirectory);

  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink()) throw new Error(`Refusing to replace a symbolic Wiki index: ${indexPath}`);
    throw new Error(`Refusing to replace an unexpected Wiki entry: ${indexPath}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const content = await renderWikiIndex(wikiRoot, indexPath, targetPages, targetIndexes, spec, language);
  // Pre-check above refuses existing entries; atomic rename finalizes the new index.
  await writeText(absolute, content);
}

export async function renderWikiIndex(
  wikiRoot: string,
  indexPath: string,
  targetPages: readonly string[],
  targetIndexes: readonly string[],
  spec: WikiSpec,
  language: "zh" | "en",
): Promise<string> {
  const relativeDirectory = path.posix.dirname(indexPath) === "." ? "" : path.posix.dirname(indexPath);
  const directPages = targetPages
    .filter((page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory)
    .sort();
  const directDirectories = targetIndexes
    .map((candidate) => path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate))
    .filter((candidate) => candidate && (path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate)) === relativeDirectory)
    .sort();
  const descriptor = directoryDescriptor(relativeDirectory, targetPages, spec, language);
  const title = descriptor.title;
  const lines = indexPath === "index.md"
    ? ["---", 'okf_version: "0.2"', "---", "", `# ${escapeMarkdownText(title)}`, ""]
    : [`# ${escapeMarkdownText(title)}`, ""];
  if (descriptor.description) lines.push(escapeMarkdownText(descriptor.description), "");
  if (directDirectories.length) {
    lines.push(
      "## Directories",
      "",
      ...directDirectories.map((child) => {
        const name = path.posix.basename(child);
        const childDescriptor = directoryDescriptor(child, targetPages, spec, language);
        return `- [${escapeMarkdownText(childDescriptor.title)}](./${name}/index.md): ${escapeMarkdownText(childDescriptor.description)}`;
      }),
      "",
    );
  }
  if (directPages.length) {
    const pageMetadata = await Promise.all(directPages.map(async (page) => {
      const parsed = parsePage(await readText(safeWikiPath(wikiRoot, page)));
      return {
        description: normalizeIndexText(parsed.frontmatter.description),
        name: path.posix.basename(page),
        title: normalizeIndexText(parsed.frontmatter.title),
      };
    }));
    lines.push(
      "## Pages",
      "",
      ...pageMetadata.map((page) => `- [${escapeMarkdownText(page.title)}](./${page.name}): ${escapeMarkdownText(page.description)}`),
      "",
    );
  }
  return `${lines.join("\n").replace(/\n+$/, "\n")}`;
}

function directoryDescriptor(
  relativeDirectory: string,
  targetPages: readonly string[],
  spec: WikiSpec,
  language: "zh" | "en",
): { description: string; title: string } {
  if (!relativeDirectory) return { title: "Wiki", description: "" };
  if (!relativeDirectory.includes("/")) {
    const domain = spec.domains.find((candidate) => candidate.pages.some((page) => page.path.startsWith(`${relativeDirectory}/`)));
    if (domain) return { title: normalizeIndexText(domain.title), description: normalizeIndexText(domain.purpose) };
  }
  const count = targetPages.filter((page) => page.startsWith(`${relativeDirectory}/`)).length;
  return {
    title: path.posix.basename(relativeDirectory),
    description: language === "zh" ? `${count} 个概念页面` : `${count} concept ${count === 1 ? "page" : "pages"}`,
  };
}

async function assertSafeDirectoryChain(wikiRoot: string, relative: string): Promise<void> {
  let current = wikiRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    current = inside(wikiRoot, path.join(current, segment));
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) throw new Error(`Wiki index directory must not be a symbolic link: ${relative}`);
    if (!entry.isDirectory()) throw new Error(`Wiki index parent is not a directory: ${relative}`);
    inside(wikiRoot, await realpath(current));
  }
}


function normalizeIndexText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_[\]{}#!|])/g, "\\$1");
}
