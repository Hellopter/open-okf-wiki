import { lstat, mkdir, readFile, readdir, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import mermaid from "mermaid";
import { inside, readText } from "./files.js";
import { parsePage } from "./frontmatter.js";
import type { WikiFinalization, WikiValidation, WikiValidationIssue } from "./types.js";
import { isSafeWikiPagePath } from "./wiki-path.js";
import type { WikiSpec } from "./workflow-types.js";
import { loadWikiWorkspace, type ResolvedWikiSource } from "./workspace.js";

const SOURCE_REFERENCE = /^([^\\/#][^#\\]*?)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;
const REPOSITORY_CITATION = /^repo:(.+)$/;
interface MermaidFence {
  body: string;
  closed: boolean;
  line: number;
}

interface SourceRange {
  end: number;
  path: string;
  start: number;
}

export interface ResolvedWikiRoots {
  sources: Map<string, ResolvedWikiSource>;
  wiki: string;
  workspace: string;
}

interface WikiTreeScan {
  markdown: string[];
  issues: WikiValidationIssue[];
}

/**
 * Validate only the candidate pages declared by the final WikiSpec.
 *
 * This function is intentionally read-only. Indexes are treated as a virtual,
 * deterministic projection of the target page tree and are written only by
 * finalizeWiki after both static and semantic review have passed.
 */
export async function validateWiki(root: string, spec: WikiSpec, wikiDirectory = "wiki"): Promise<WikiValidation> {
  const issues: WikiValidationIssue[] = [];
  const targetPages = specPagePaths(spec, issues);
  if (wikiDirectory !== "wiki") {
    issue(issues, "wiki-directory", "Wiki output is fixed at workspace-relative wiki/");
    return validationResult(issues, [], []);
  }

  let roots: ResolvedWikiRoots;
  try {
    roots = await resolveWikiRoots(root);
  } catch (error) {
    issue(issues, "wiki-safety", errorMessage(error));
    return validationResult(issues, [], []);
  }

  const tree = await scanWikiTree(roots.wiki);
  issues.push(...tree.issues);
  const targetSet = new Set(targetPages);
  const plannedTargets = new Set([...targetPages, ...derivedIndexPaths(targetPages)]);
  const actualPages = tree.markdown
    .filter((page) => path.posix.basename(page) !== "index.md" && targetSet.has(page))
    .sort();
  const obsoletePages = tree.markdown
    .filter((page) => path.posix.basename(page) !== "index.md" && !targetSet.has(page))
    .sort();
  const bodies = new Map<string, string>();

  for (const page of targetPages) {
    const absolute = path.join(roots.wiki, ...page.split("/"));
    let entry;
    try {
      entry = await lstat(absolute);
    } catch {
      issue(issues, "missing-page", `Target page is missing: ${page}`, page);
      continue;
    }
    if (entry.isSymbolicLink()) {
      issue(issues, "wiki-safety", `Target page must not be a symbolic link: ${page}`, page);
      continue;
    }
    if (!entry.isFile()) {
      issue(issues, "wiki-safety", `Target page is not a regular file: ${page}`, page);
      continue;
    }

    let parsed: ReturnType<typeof parsePage>;
    try {
      parsed = parsePage(await readText(absolute));
    } catch (error) {
      issue(issues, "frontmatter", errorMessage(error), page);
      continue;
    }

    bodies.set(page, parsed.body);
    await validateFrontmatter(page, parsed.frontmatter, roots, issues);
    await validateBody(page, parsed.body, roots, plannedTargets, issues);
  }

  validateCrossLinks(spec, bodies, targetSet, issues);
  return validationResult(issues, actualPages, obsoletePages);
}

/**
 * Apply the deterministic Wiki lifecycle after semantic review has passed.
 * A failed operation throws and can be retried without relying on saved state.
 */
export async function finalizeWiki(root: string, spec: WikiSpec, wikiDirectory = "wiki"): Promise<WikiFinalization> {
  const validation = await validateWiki(root, spec, wikiDirectory);
  if (!validation.ok) {
    throw new Error(`Wiki finalization requires a valid target Wiki: ${validation.issues.map(formatIssue).join("; ")}`);
  }

  const targetPages = specPagePaths(spec);
  if (!sameStrings(validation.pages, targetPages)) {
    throw new Error("Wiki finalization requires every target page to exist");
  }

  const roots = await resolveWikiRoots(root);
  const before = await scanWikiTree(roots.wiki);
  if (before.issues.length) throw new Error(`Unsafe Wiki tree: ${before.issues.map(formatIssue).join("; ")}`);
  const existingIndexes = before.markdown.filter((page) => path.posix.basename(page) === "index.md");
  const obsoletePages = [...validation.obsoletePages];
  const removedPages: string[] = [];

  for (const page of [...new Set([...obsoletePages, ...existingIndexes])].sort()) {
    const removed = await removeRegularWikiFile(roots.wiki, page);
    if (removed && obsoletePages.includes(page)) removedPages.push(page);
  }

  await removeEmptyWikiDirectories(roots.wiki);
  const rebuiltIndexes = derivedIndexPaths(targetPages);
  for (const indexPath of rebuiltIndexes) {
    await writeWikiIndex(roots.wiki, indexPath, targetPages, rebuiltIndexes);
  }

  const after = await scanWikiTree(roots.wiki);
  if (after.issues.length) throw new Error(`Unsafe Wiki tree after finalization: ${after.issues.map(formatIssue).join("; ")}`);
  const finalPages = after.markdown.filter((page) => path.posix.basename(page) !== "index.md").sort();
  const finalIndexes = after.markdown.filter((page) => path.posix.basename(page) === "index.md").sort();
  if (!sameStrings(finalPages, targetPages)) throw new Error("Final Wiki page set does not exactly match the WikiSpec");
  if (!sameStrings(finalIndexes, rebuiltIndexes)) throw new Error("Final Wiki index set does not match the target page tree");

  return {
    pages: targetPages,
    obsoletePages,
    removedPages: removedPages.sort(),
    rebuiltIndexes,
  };
}

export async function resolveWikiRoots(root: string): Promise<ResolvedWikiRoots> {
  const configured = await loadWikiWorkspace(root);
  const requestedWorkspace = path.resolve(configured.root);
  const workspace = await realpath(requestedWorkspace);
  const requestedWiki = inside(requestedWorkspace, path.join(requestedWorkspace, "wiki"));
  let wikiEntry;
  try {
    wikiEntry = await lstat(requestedWiki);
  } catch {
    throw new Error("wiki directory is missing");
  }
  if (wikiEntry.isSymbolicLink()) throw new Error("wiki directory must not be a symbolic link");
  if (!wikiEntry.isDirectory()) throw new Error("wiki directory is not a directory: wiki");
  const wiki = await realpath(requestedWiki);
  inside(workspace, wiki);
  return { workspace, wiki, sources: new Map(configured.sources.map((source) => [source.path, source])) };
}

export function specPagePaths(spec: WikiSpec, issues?: WikiValidationIssue[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const page of spec.domains.flatMap((domain) => domain.pages)) {
    if (!isSafeWikiPagePath(page.path)) {
      if (issues) issue(issues, "spec-page", `Spec contains an unsafe or reserved page path: ${page.path}`);
      continue;
    }
    if (seen.has(page.path)) {
      if (issues) issue(issues, "spec-page", `Spec contains a duplicate page path: ${page.path}`, page.path);
      continue;
    }
    seen.add(page.path);
    paths.push(page.path);
  }
  return paths.sort();
}

export function derivedIndexPaths(pages: readonly string[]): string[] {
  const directories = new Set<string>([""]);
  for (const page of pages) {
    let directory = path.posix.dirname(page);
    while (directory && directory !== ".") {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories]
    .map((directory) => directory ? `${directory}/index.md` : "index.md")
    .sort();
}

async function scanWikiTree(wikiRoot: string, relative = ""): Promise<WikiTreeScan> {
  const markdown: string[] = [];
  const issues: WikiValidationIssue[] = [];
  const directory = relative ? path.join(wikiRoot, ...relative.split("/")) : wikiRoot;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      issue(issues, "wiki-safety", `Wiki tree must not contain symbolic links: ${child}`);
    } else if (entry.isDirectory()) {
      const nested = await scanWikiTree(wikiRoot, child);
      markdown.push(...nested.markdown);
      issues.push(...nested.issues);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".md")) markdown.push(child);
    } else {
      issue(issues, "wiki-safety", `Wiki tree contains a non-regular entry: ${child}`);
    }
  }
  return { markdown: markdown.sort(), issues };
}

async function removeRegularWikiFile(wikiRoot: string, relative: string): Promise<boolean> {
  const absolute = safeWikiPath(wikiRoot, relative);
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`Refusing to remove a symbolic link from wiki/: ${relative}`);
  if (!entry.isFile()) throw new Error(`Refusing to remove a non-regular Wiki file: ${relative}`);
  inside(wikiRoot, await realpath(absolute));
  await unlink(absolute);
  return true;
}

async function removeEmptyWikiDirectories(wikiRoot: string, relative = ""): Promise<void> {
  const directory = relative ? safeWikiPath(wikiRoot, relative) : wikiRoot;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    await removeEmptyWikiDirectories(wikiRoot, child);
  }
  if (relative && (await readdir(directory)).length === 0) await rmdir(directory);
}

async function writeWikiIndex(
  wikiRoot: string,
  indexPath: string,
  targetPages: readonly string[],
  targetIndexes: readonly string[],
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

  const directPages = targetPages
    .filter((page) => (path.posix.dirname(page) === "." ? "" : path.posix.dirname(page)) === relativeDirectory)
    .sort();
  const directDirectories = targetIndexes
    .map((candidate) => path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate))
    .filter((candidate) => candidate && (path.posix.dirname(candidate) === "." ? "" : path.posix.dirname(candidate)) === relativeDirectory)
    .sort();
  const title = relativeDirectory ? path.posix.basename(relativeDirectory) : "Wiki";
  const lines = [`# ${title}`, ""];
  if (directDirectories.length) {
    lines.push(
      "## Directories",
      "",
      ...directDirectories.map((child) => {
        const name = path.posix.basename(child);
        return `- [${name}/](./${name}/index.md)`;
      }),
      "",
    );
  }
  if (directPages.length) {
    lines.push(
      "## Pages",
      "",
      ...directPages.map((page) => {
        const name = path.posix.basename(page);
        return `- [${name.replace(/\.md$/, "")}](./${name})`;
      }),
      "",
    );
  }
  const content = `${lines.join("\n").replace(/\n+$/, "\n")}`;
  await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
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

function safeWikiPath(wikiRoot: string, relative: string): string {
  if (!relative || relative.includes("\\") || relative.startsWith("/")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === "." || normalized.startsWith("../")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const absolute = inside(wikiRoot, path.resolve(wikiRoot, ...relative.split("/")));
  if (absolute === path.resolve(wikiRoot)) throw new Error("Refusing to operate on the Wiki root directory");
  return absolute;
}

async function validateFrontmatter(
  page: string,
  frontmatter: Record<string, unknown>,
  roots: ResolvedWikiRoots,
  issues: WikiValidationIssue[],
): Promise<void> {
  for (const field of ["type", "title", "description"] as const) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) {
      issue(issues, "frontmatter", `Frontmatter requires a non-empty ${field}`, page);
    }
  }

  const tags = frontmatter.tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.length || tags.some((tag) => typeof tag !== "string" || !tag.trim()))) {
    issue(issues, "frontmatter", "Frontmatter tags must be a non-empty string array", page);
  }

  const sources = frontmatter.sources;
  if (!Array.isArray(sources) || !sources.length || sources.some((source) => typeof source !== "string" || !source.trim())) {
    issue(issues, "frontmatter", "Frontmatter sources must be a non-empty string array", page);
    return;
  }

  for (const source of sources) {
    await validateSourceReference(page, source as string, roots, "frontmatter source", issues);
  }
}

async function validateBody(
  page: string,
  body: string,
  roots: ResolvedWikiRoots,
  plannedTargets: ReadonlySet<string>,
  issues: WikiValidationIssue[],
): Promise<void> {
  for (const fence of mermaidFences(body)) {
    if (!fence.closed) {
      issue(issues, "mermaid", `Mermaid fence opened on line ${fence.line} is not closed`, page);
      continue;
    }
    const problem = await mermaidError(fence.body);
    if (problem) issue(issues, "mermaid", `Mermaid fence on line ${fence.line} is invalid: ${problem}`, page);
  }

  for (const target of markdownTargets(body)) {
    const repositoryCitation = REPOSITORY_CITATION.exec(target);
    if (repositoryCitation) {
      if (!parseSourceReference(repositoryCitation[1])) {
        issue(issues, "source-reference", `Repo citation must be repo:<workspace-relative-path>#Lx-Ly: ${target}`, page);
        continue;
      }
      await validateSourceReference(page, repositoryCitation[1], roots, "repo citation", issues);
      continue;
    }
    if (target.startsWith("repo:")) {
      issue(issues, "source-reference", `Repo citation must be repo:<workspace-relative-path>#Lx-Ly: ${target}`, page);
      continue;
    }
    validateInternalMarkdownLink(page, target, plannedTargets, issues);
  }
}

async function validateSourceReference(
  page: string,
  reference: string,
  roots: ResolvedWikiRoots,
  label: string,
  issues: WikiValidationIssue[],
): Promise<void> {
  const parsed = parseSourceReference(reference);
  if (!parsed) {
    issue(issues, "source-reference", `${label} must be workspace-relative with #Lx-Ly: ${reference}`, page);
    return;
  }
  if (parsed.end < parsed.start) {
    issue(issues, "source-reference", `${label} has an invalid line range: ${reference}`, page);
    return;
  }

  const [sourceName] = parsed.path.split("/", 1);
  const source = roots.sources.get(sourceName);
  if (!source) {
    issue(issues, "source-reference", `${label} must start with a declared source directory: ${reference}`, page);
    return;
  }

  let sourceFile: string;
  try {
    sourceFile = inside(roots.workspace, path.resolve(roots.workspace, parsed.path));
  } catch {
    issue(issues, "source-reference", `${label} escapes the workspace: ${reference}`, page);
    return;
  }

  await validateSourceFile(page, source, sourceFile, reference, label, parsed, issues);
}

async function validateSourceFile(
  page: string,
  source: ResolvedWikiSource,
  sourceFile: string,
  reference: string,
  label: string,
  range: SourceRange,
  issues: WikiValidationIssue[],
): Promise<void> {
  try {
    const physicalSource = await realpath(sourceFile);
    try {
      inside(source.realPath, physicalSource);
    } catch {
      issue(issues, "source-reference", `${label} resolves outside declared source ${source.path}: ${reference}`, page);
      return;
    }
    if (!(await stat(physicalSource)).isFile()) {
      issue(issues, "source-reference", `${label} does not name a file: ${reference}`, page);
      return;
    }
    if (lineCount(await readFile(physicalSource, "utf8")) < range.end) {
      issue(issues, "source-reference", `${label} line range exceeds file: ${reference}`, page);
    }
  } catch {
    issue(issues, "source-reference", `${label} file is missing: ${reference}`, page);
  }
}

function parseSourceReference(value: string): SourceRange | undefined {
  const match = SOURCE_REFERENCE.exec(value);
  if (!match) return undefined;
  const resourcePath = match[1];
  const segments = resourcePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return { path: resourcePath, start: Number(match[2]), end: Number(match[3] ?? match[2]) };
}

function validateInternalMarkdownLink(
  page: string,
  target: string,
  plannedTargets: ReadonlySet<string>,
  issues: WikiValidationIssue[],
): void {
  const resolved = resolveInternalMarkdownLink(page, target);
  if (resolved === undefined) return;
  if (resolved === null) {
    issue(issues, "internal-link", `Internal Markdown link escapes wiki/: ${target}`, page);
    return;
  }
  if (!plannedTargets.has(resolved)) {
    issue(issues, "internal-link", `Internal Markdown link target is not in the target Wiki: ${target}`, page);
  }
}

function resolveInternalMarkdownLink(page: string, target: string): string | null | undefined {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const resource = target.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(resource);
  } catch {
    return null;
  }
  if (!decoded.endsWith(".md") || decoded.includes("\\") || decoded.startsWith("/")) {
    return decoded.endsWith(".md") ? null : undefined;
  }
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), decoded));
  if (resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) return null;
  return resolved;
}

function validateCrossLinks(
  spec: WikiSpec,
  bodies: ReadonlyMap<string, string>,
  targetPages: ReadonlySet<string>,
  issues: WikiValidationIssue[],
): void {
  for (const link of spec.crossLinks ?? []) {
    if (!targetPages.has(link.fromPath) || !targetPages.has(link.toPath)) {
      issue(issues, "cross-link", `Declared cross-link references a page outside the target Wiki: ${link.fromPath} -> ${link.toPath}`);
      continue;
    }
    const targets = markdownTargets(bodies.get(link.fromPath) ?? "")
      .map((target) => resolveInternalMarkdownLink(link.fromPath, target));
    if (!targets.includes(link.toPath)) {
      issue(issues, "cross-link", `Declared cross-link is missing: ${link.fromPath} -> ${link.toPath}`, link.fromPath);
    }
  }
}

function markdownTargets(markdown: string): string[] {
  const targets = new Set<string>();
  const definitions = new Map<string, string>();
  const visible = markdownOutsideCode(markdown);
  const withoutDefinitions = visible.replace(
    /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^ \t\n]+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?[ \t]*$/gm,
    (line: string, label: string, bracketedTarget: string | undefined, bareTarget: string | undefined) => {
      const target = bracketedTarget ?? bareTarget;
      if (target) {
        definitions.set(referenceLabel(label), target);
      }
      return line.replace(/[^\r\n]/g, " ");
    },
  );
  const inline = /(?<!!)\[[^\]\n]*\]\([ \t]*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^\)]*\)))?[ \t]*\)/g;
  for (const match of withoutDefinitions.matchAll(inline)) targets.add(match[1] ?? match[2]);

  const fullReference = /(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const match of withoutDefinitions.matchAll(fullReference)) {
    const target = definitions.get(referenceLabel(match[2] || match[1]));
    if (target) targets.add(target);
  }

  const shortcutReference = /(?<!!)\[([^\]\n]+)\](?![\[(:])/g;
  for (const match of withoutDefinitions.matchAll(shortcutReference)) {
    const target = definitions.get(referenceLabel(match[1]));
    if (target) targets.add(target);
  }

  return [...targets];
}

function markdownOutsideCode(markdown: string): string {
  const lines: string[] = [];
  let open: { marker: string } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (open) {
      if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && !fence[3]) open = undefined;
      lines.push("");
    } else if (fence) {
      open = { marker: fence[2] };
      lines.push("");
    } else {
      lines.push(withoutInlineCode(line));
    }
  }
  return lines.join("\n");
}

function withoutInlineCode(line: string): string {
  const characters = line.split("");
  for (let index = 0; index < characters.length;) {
    if (characters[index] !== "`") {
      index++;
      continue;
    }
    let markerLength = 1;
    while (characters[index + markerLength] === "`") markerLength++;
    const marker = "`".repeat(markerLength);
    const close = line.indexOf(marker, index + markerLength);
    const end = close < 0 ? characters.length : close + markerLength;
    for (let cursor = index; cursor < end; cursor++) characters[cursor] = " ";
    index = end;
  }
  return characters.join("");
}

function referenceLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function mermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  let open: { marker: string; line: number; body: string[] } | undefined;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const fence = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (open) {
      if (fence && fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && !fence[3]) {
        fences.push({ line: open.line, body: open.body.join("\n"), closed: true });
        open = undefined;
      } else {
        open.body.push(line);
      }
    } else if (fence?.[3].toLowerCase() === "mermaid") {
      open = { marker: fence[2], line: index + 1, body: [] };
    }
  }
  if (open) fences.push({ line: open.line, body: open.body.join("\n"), closed: false });
  return fences;
}

async function mermaidError(body: string): Promise<string | undefined> {
  const meaningful = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("%%"));
  const directive = meaningful[0]?.split(/\s+/, 1)[0].toLowerCase();
  if (!directive) return "diagram is empty";
  if (/%%\s*\{/.test(body)) return "Mermaid configuration directives are not allowed";
  if (/^\s*click\s+\S+/im.test(body)) return "interactive Mermaid click actions are not allowed";
  const normalizedUrls = body
    .replace(/&#(?:x0*3a|0*58);?/gi, ":")
    .replace(/%0*3a/gi, ":");
  if (/\b(?:javascript|vbscript|data)\s*:/i.test(normalizedUrls)) return "diagram contains an unsafe URL";
  if (/\bon[a-z]+\s*=/i.test(body)) return "diagram contains an HTML event handler";
  if ((directive === "flowchart" || directive === "graph") && (/(?:^|\n|\s)end\s*[[({]/.test(body) || /-->\s*end\s*(?:$|\n|;)/m.test(body))) {
    return "flowchart uses reserved word `end` as a node id";
  }
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/.test(body)) return "diagram contains a semicolon inside a label";
  if (!await mermaid.parse(body, { suppressErrors: true })) return "syntax error";
  return undefined;
}

function validationResult(issues: WikiValidationIssue[], pages: string[], obsoletePages: string[]): WikiValidation {
  return { ok: issues.length === 0, issues, pages, obsoletePages };
}

function issue(issues: WikiValidationIssue[], code: string, message: string, page?: string): void {
  issues.push(page ? { code, page, message } : { code, message });
}

function formatIssue(value: WikiValidationIssue): string {
  return value.page ? `${value.page}: ${value.message}` : value.message;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
