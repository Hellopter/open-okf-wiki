import { lstat, mkdir, readFile, readdir, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { inside, readText } from "./files.js";
import { okfSources, parsePage, stringifyPage } from "./frontmatter.js";
import type { WikiFinalization, WikiValidation, WikiValidationIssue } from "./types.js";
import { isSafeWikiPagePath } from "./wiki-path.js";
import type { WikiSpec, WikiSpecPage } from "./workflow-types.js";
import { loadWikiWorkspace, type ResolvedWikiSource } from "./workspace.js";

const SOURCE_REFERENCE = /^([^\\/#][^#\\]*?)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;
const REPOSITORY_CITATION = /^repo:(.+)$/;
const MERMAID_FLOW_DIRECTIONS = new Set(["TB", "TD", "BT", "RL", "LR"]);
const MERMAID_DIAGRAM_TYPES = new Set(["sequenceDiagram", "classDiagram", "stateDiagram-v2", "erDiagram"]);
const GENERATED_BY = "open-okf-wiki/1.0.0";
const VERIFIED_BY = "process:open-okf-wiki";
const PUBLISHER_OWNED_FIELDS = ["okf_version", "generated", "verified", "human", "stale_after"] as const;
const MERMAID_EVENT_HANDLER = /<[^>]+\bon(?:abort|animationcancel|animationend|animationiteration|animationstart|auxclick|beforeinput|beforetoggle|begin|blur|cancel|canplay|canplaythrough|change|click|close|contextmenu|copy|cuechange|cut|dblclick|drag|dragend|dragenter|dragleave|dragover|dragstart|drop|durationchange|emptied|end|ended|error|focus|focusin|focusout|formdata|fullscreenchange|fullscreenerror|gotpointercapture|input|invalid|keydown|keypress|keyup|load|loadeddata|loadedmetadata|loadstart|lostpointercapture|mousedown|mouseenter|mouseleave|mousemove|mouseout|mouseover|mouseup|paste|pause|play|playing|pointercancel|pointerdown|pointerenter|pointerleave|pointermove|pointerout|pointerover|pointerup|progress|ratechange|repeat|reset|resize|scroll|scrollend|securitypolicyviolation|seeked|seeking|select|selectionchange|selectstart|slotchange|stalled|submit|suspend|timeupdate|toggle|touchcancel|touchend|touchmove|touchstart|transitioncancel|transitionend|transitionrun|transitionstart|volumechange|waiting|wheel)\s*=/i;
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

interface SourceDeclarations {
  complete: boolean;
  sources: Map<string, string>;
}

interface SourceFootnoteDefinition {
  content: string;
  id: string;
}

interface SourceFootnoteScan {
  bodyWithoutDefinitions: string;
  definitions: SourceFootnoteDefinition[];
  references: string[];
}

interface MermaidProblem {
  code: "mermaid-syntax" | "mermaid-policy";
  message: string;
}

type WikiValidationMode = "candidate" | "global";

export interface ResolvedWikiRoots {
  language: "zh" | "en";
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
 * This function is intentionally read-only. Indexes must already match the
 * deterministic projection materialized after the current write/repair wave.
 */
export async function validateWiki(root: string, spec: WikiSpec, wikiDirectory = "wiki"): Promise<WikiValidation> {
  return validateWikiCandidate(root, spec, wikiDirectory, true);
}

async function validateWikiCandidate(
  root: string,
  spec: WikiSpec,
  wikiDirectory: string,
  validateIndexes: boolean,
): Promise<WikiValidation> {
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
  const specPages = new Map(spec.domains.flatMap((domain) => domain.pages).map((page) => [page.path, page]));
  const plannedTargets = new Set([...targetPages, ...derivedIndexPaths(targetPages)]);
  const actualPages = tree.markdown
    .filter((page) => path.posix.basename(page) !== "index.md" && targetSet.has(page))
    .sort();
  const obsoletePages = tree.markdown
    .filter((page) => path.posix.basename(page) !== "index.md" && !targetSet.has(page))
    .sort();
  const bodies = new Map<string, string>();
  const indexablePages = new Set<string>();

  for (const page of targetPages) {
    const body = await validateTargetPage(roots, specPages.get(page)!, plannedTargets, "global", issues);
    if (body !== undefined) {
      bodies.set(page, body);
      indexablePages.add(page);
    }
  }

  validateCrossLinks(spec, bodies, targetSet, issues);
  if (validateIndexes && !issues.some((entry) => entry.code === "spec-page")) {
    await validateWikiIndexes(roots, spec, targetPages, indexablePages, tree.markdown, issues);
  }
  return validationResult(issues, actualPages, obsoletePages);
}

/** Validate one writer-owned page without requiring its concurrently written peers to exist. */
export async function validateWikiPage(root: string, spec: WikiSpec, page: string): Promise<WikiValidationIssue[]> {
  const issues: WikiValidationIssue[] = [];
  if (!isSafeWikiPagePath(page)) {
    issue(issues, "spec-page", `Page is unsafe or reserved: ${page}`, page);
    return issues;
  }
  const targetPages = specPagePaths(spec);
  if (!targetPages.includes(page)) {
    issue(issues, "spec-page", `Page is not declared in the WikiSpec: ${page}`, page);
    return issues;
  }

  const roots = await resolveWikiRoots(root);
  const targetSet = new Set(targetPages);
  const plannedTargets = new Set([...targetPages, ...derivedIndexPaths(targetPages)]);
  const specPage = spec.domains.flatMap((domain) => domain.pages).find((candidate) => candidate.path === page)!;
  const body = await validateTargetPage(roots, specPage, plannedTargets, "candidate", issues);
  if (body !== undefined) validateCrossLinksFromPage(spec, page, body, targetSet, issues);
  return issues;
}

/**
 * Apply the deterministic Wiki lifecycle after semantic review has passed.
 * A failed operation throws and can be retried without relying on saved state.
 */
export async function finalizeWiki(
  root: string,
  spec: WikiSpec,
  wikiDirectory = "wiki",
  publicationAt = new Date().toISOString(),
): Promise<WikiFinalization> {
  assertPublicationTimestamp(publicationAt);
  const validation = await validateWikiCandidate(root, spec, wikiDirectory, false);
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
  const obsoletePages = [...validation.obsoletePages];
  const removedPages: string[] = [];

  for (const page of obsoletePages) {
    const removed = await removeRegularWikiFile(roots.wiki, page);
    if (removed) removedPages.push(page);
  }

  await stampWikiPages(roots.wiki, targetPages, publicationAt);
  const rebuiltIndexes = await materializeWikiIndexes(root, spec);
  await removeEmptyWikiDirectories(roots.wiki);

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

/** Replace the deterministic index projection without modifying concept pages. */
export async function materializeWikiIndexes(root: string, spec: WikiSpec): Promise<string[]> {
  const specIssues: WikiValidationIssue[] = [];
  const targetPages = specPagePaths(spec, specIssues);
  if (specIssues.length) throw new Error(`Cannot materialize Wiki indexes: ${specIssues.map(formatIssue).join("; ")}`);

  const roots = await resolveWikiRoots(root);
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

async function stampWikiPages(wikiRoot: string, targetPages: readonly string[], publicationAt: string): Promise<void> {
  const stamped: Array<{ absolute: string; content: string }> = [];
  for (const page of targetPages) {
    const absolute = safeWikiPath(wikiRoot, page);
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Cannot stamp a non-regular Wiki page: ${page}`);
    const parsed = parsePage(await readText(absolute));
    if (!isPublisherActor(parsed.frontmatter.generated, GENERATED_BY, true)) {
      parsed.frontmatter.generated = { by: GENERATED_BY, at: publicationAt };
    }
    parsed.frontmatter.verified = { by: VERIFIED_BY, at: publicationAt };
    stamped.push({ absolute, content: stringifyPage(parsed) });
  }
  for (const page of stamped) await writeFile(page.absolute, page.content, "utf8");
}

function assertPublicationTimestamp(value: string): void {
  if (!isIsoTimestamp(value)) throw new Error(`Wiki publication timestamp must be an ISO-8601 date-time: ${value}`);
}

async function validateWikiIndexes(
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
  return {
    workspace,
    wiki,
    language: configured.language,
    sources: new Map(configured.sources.map((source) => [source.path, source])),
  };
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
  await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
}

async function renderWikiIndex(
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

function safeWikiPath(wikiRoot: string, relative: string): string {
  if (!relative || relative.includes("\\") || relative.startsWith("/")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === "." || normalized.startsWith("../")) throw new Error(`Unsafe Wiki path: ${relative}`);
  const absolute = inside(wikiRoot, path.resolve(wikiRoot, ...relative.split("/")));
  if (absolute === path.resolve(wikiRoot)) throw new Error("Refusing to operate on the Wiki root directory");
  return absolute;
}

async function validateTargetPage(
  roots: ResolvedWikiRoots,
  specPage: WikiSpecPage,
  plannedTargets: ReadonlySet<string>,
  mode: WikiValidationMode,
  issues: WikiValidationIssue[],
): Promise<string | undefined> {
  const page = specPage.path;
  const absolute = path.join(roots.wiki, ...page.split("/"));
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
    issue(issues, "missing-page", `Target page is missing: ${page}`, page);
    return undefined;
  }
  if (entry.isSymbolicLink()) {
    issue(issues, "wiki-safety", `Target page must not be a symbolic link: ${page}`, page);
    return undefined;
  }
  if (!entry.isFile()) {
    issue(issues, "wiki-safety", `Target page is not a regular file: ${page}`, page);
    return undefined;
  }

  const text = await readText(absolute);
  let parsed: ReturnType<typeof parsePage>;
  try {
    parsed = parsePage(text);
  } catch (error) {
    issue(issues, "frontmatter", errorMessage(error), page);
    return undefined;
  }

  const sources = await validateFrontmatter(page, specPage.pageType, parsed.frontmatter, roots, mode, issues);
  await validateBody(page, parsed.body, roots, plannedTargets, sources, issues);
  return parsed.body;
}

async function validateFrontmatter(
  page: string,
  pageType: WikiSpecPage["pageType"],
  frontmatter: Record<string, unknown>,
  roots: ResolvedWikiRoots,
  mode: WikiValidationMode,
  issues: WikiValidationIssue[],
): Promise<SourceDeclarations> {
  for (const field of ["title", "description"] as const) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) {
      issue(issues, "frontmatter", `Frontmatter requires a non-empty ${field}`, page);
    }
  }

  const expectedType = canonicalPageType(pageType);
  if (frontmatter.type !== expectedType) {
    issue(issues, "frontmatter", `Frontmatter type must match WikiSpec page type: ${expectedType}`, page);
  }

  validateTrustFrontmatter(page, frontmatter, mode, issues);

  const tags = frontmatter.tags;
  if (tags !== undefined && (!Array.isArray(tags) || !tags.length || tags.some((tag) => typeof tag !== "string" || !tag.trim()))) {
    issue(issues, "frontmatter", "Frontmatter tags must be a non-empty string array", page);
  }

  const sources = frontmatter.sources;
  const parsedSources = okfSources(sources);
  if (!parsedSources) {
    issue(issues, "frontmatter", "Frontmatter sources must be a non-empty array of { id, resource } objects", page);
    return { complete: false, sources: new Map() };
  }

  const ids = new Set<string>();
  const declared = new Map<string, string>();
  let complete = true;
  for (const source of parsedSources) {
    if (ids.has(source.id)) {
      issue(issues, "frontmatter", `Frontmatter source ids must be unique: ${source.id}`, page);
      complete = false;
    }
    ids.add(source.id);
    if (!declared.has(source.id)) declared.set(source.id, source.resource);
    await validateSourceReference(page, source.resource, roots, `frontmatter source ${source.id}`, issues);
  }
  return { complete, sources: declared };
}

function validateTrustFrontmatter(
  page: string,
  frontmatter: Record<string, unknown>,
  mode: WikiValidationMode,
  issues: WikiValidationIssue[],
): void {
  if (mode === "candidate") {
    for (const field of PUBLISHER_OWNED_FIELDS) {
      if (Object.hasOwn(frontmatter, field)) {
        issue(issues, "frontmatter", `Frontmatter field is publisher-owned and forbidden in writer output: ${field}`, page);
      }
    }
    return;
  }

  for (const field of ["okf_version", "human", "stale_after"] as const) {
    if (Object.hasOwn(frontmatter, field)) {
      issue(issues, "frontmatter", `Concept page frontmatter must not contain publisher-reserved field: ${field}`, page);
    }
  }
  if (frontmatter.generated !== undefined && !isPublisherActor(frontmatter.generated, GENERATED_BY, false)) {
    issue(issues, "frontmatter", `Frontmatter generated must use publisher actor ${GENERATED_BY}`, page);
  }
  if (frontmatter.verified !== undefined) {
    const values = Array.isArray(frontmatter.verified) ? frontmatter.verified : [frontmatter.verified];
    if (!values.length || values.some((value) => !isPublisherActor(value, VERIFIED_BY, true))) {
      issue(issues, "frontmatter", `Frontmatter verified must use publisher actor ${VERIFIED_BY}`, page);
    }
  }
}

function isPublisherActor(value: unknown, by: string, requireTimestamp: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  if (actor.by !== by) return false;
  if (requireTimestamp && typeof actor.at !== "string") return false;
  if (actor.at !== undefined && (typeof actor.at !== "string" || !isIsoTimestamp(actor.at))) return false;
  return Object.keys(actor).every((key) => key === "by" || key === "at");
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

async function validateBody(
  page: string,
  body: string,
  roots: ResolvedWikiRoots,
  plannedTargets: ReadonlySet<string>,
  sources: SourceDeclarations,
  issues: WikiValidationIssue[],
): Promise<void> {
  for (const fence of mermaidFences(body)) {
    if (!fence.closed) {
      issue(issues, "mermaid-syntax", `Mermaid fence opened on line ${fence.line} is not closed`, page);
      continue;
    }
    for (const problem of mermaidProblems(fence.body)) {
      issue(issues, problem.code, `Mermaid fence on line ${fence.line} is invalid: ${problem.message}`, page);
    }
  }

  const footnotes = sourceFootnotes(body);
  await validateSourceFootnotes(page, footnotes, sources, roots, issues);

  for (const target of markdownTargets(footnotes.bodyWithoutDefinitions)) {
    if (target.startsWith("repo:")) {
      await validateSourceReference(page, target, roots, "repo citation", issues);
      issue(issues, "source-reference", `Direct repo citation must use a declared source footnote: ${target}`, page);
      continue;
    }
    validateInternalMarkdownLink(page, target, plannedTargets, issues);
  }
}

async function validateSourceFootnotes(
  page: string,
  scan: SourceFootnoteScan,
  declarations: SourceDeclarations,
  roots: ResolvedWikiRoots,
  issues: WikiValidationIssue[],
): Promise<void> {
  if (!declarations.complete) return;

  const referenced = new Set(scan.references);
  const definitions = new Map<string, SourceFootnoteDefinition>();
  for (const definition of scan.definitions) {
    if (definitions.has(definition.id)) {
      issue(issues, "source-reference", `Source footnote is defined more than once: ${definition.id}`, page);
    } else {
      definitions.set(definition.id, definition);
    }
    if (!declarations.sources.has(definition.id) && !referenced.has(definition.id)) {
      issue(issues, "source-reference", `Source footnote definition is not declared in frontmatter sources: ${definition.id}`, page);
    }
  }

  for (const id of referenced) {
    if (!declarations.sources.has(id)) {
      issue(issues, "source-reference", `Source footnote reference is not declared in frontmatter sources: ${id}`, page);
    }
    if (!definitions.has(id)) {
      issue(issues, "source-reference", `Source footnote reference has no definition: ${id}`, page);
    }
  }

  for (const [id, resource] of declarations.sources) {
    if (!referenced.has(id)) {
      issue(issues, "source-reference", `Frontmatter source is not cited by a footnote: ${id}`, page);
      continue;
    }
    const definition = definitions.get(id);
    if (!definition) continue;
    const resources = markdownTargetOccurrences(definition.content).filter((target) => target.startsWith("repo:"));
    if (resources.length !== 1) {
      issue(issues, "source-reference", `Source footnote definition must contain exactly one repo resource: ${id}`, page);
      continue;
    }
    if (resources[0] !== resource) {
      await validateSourceReference(page, resources[0], roots, `source footnote ${id}`, issues);
      issue(issues, "source-reference", `Source footnote resource does not match frontmatter source ${id}: ${resources[0]}`, page);
    }
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
    issue(issues, "source-reference", `${label} must be repo:<workspace-relative-path>#Lx-Ly: ${reference}`, page);
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
  } catch (error) {
    if (!isMissing(error)) throw error;
    issue(issues, "source-reference", `${label} file is missing: ${reference}`, page);
  }
}

function parseSourceReference(value: string): SourceRange | undefined {
  const repository = REPOSITORY_CITATION.exec(value);
  if (!repository) return undefined;
  const match = SOURCE_REFERENCE.exec(repository[1]);
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
  for (const page of new Set((spec.crossLinks ?? []).map((link) => link.fromPath))) {
    validateCrossLinksFromPage(spec, page, bodies.get(page) ?? "", targetPages, issues);
  }
}

function validateCrossLinksFromPage(
  spec: WikiSpec,
  page: string,
  body: string,
  targetPages: ReadonlySet<string>,
  issues: WikiValidationIssue[],
): void {
  for (const link of (spec.crossLinks ?? []).filter((candidate) => candidate.fromPath === page)) {
    if (!targetPages.has(link.fromPath) || !targetPages.has(link.toPath)) {
      issue(issues, "cross-link", `Declared cross-link references a page outside the target Wiki: ${link.fromPath} -> ${link.toPath}`);
      continue;
    }
    const targets = markdownTargets(body).map((target) => resolveInternalMarkdownLink(link.fromPath, target));
    if (!targets.includes(link.toPath)) {
      issue(issues, "cross-link", `Declared cross-link is missing: ${link.fromPath} -> ${link.toPath}`, link.fromPath);
    }
  }
}

function sourceFootnotes(markdown: string): SourceFootnoteScan {
  const lines = markdownOutsideCode(markdown).split(/\r?\n/);
  const bodyLines = [...lines];
  const definitions: SourceFootnoteDefinition[] = [];

  for (let index = 0; index < lines.length; index++) {
    const match = /^[ \t]{0,3}\[\^([^\]\n]+)\]:[ \t]*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const content = [match[2]];
    bodyLines[index] = "";
    let cursor = index + 1;
    while (cursor < lines.length) {
      const continuation = /^(?: {2,}|\t)(.*)$/.exec(lines[cursor]);
      if (continuation) {
        content.push(continuation[1]);
        bodyLines[cursor] = "";
        cursor++;
        continue;
      }
      if (!lines[cursor].trim() && /^(?: {2,}|\t)/.test(lines[cursor + 1] ?? "")) {
        content.push("");
        bodyLines[cursor] = "";
        cursor++;
        continue;
      }
      break;
    }
    definitions.push({ id: match[1], content: content.join("\n") });
    index = cursor - 1;
  }

  const bodyWithoutDefinitions = bodyLines.join("\n");
  const references: string[] = [];
  for (const match of bodyWithoutDefinitions.matchAll(/\[\^([^\]\n]+)\]/g)) {
    if (!isMarkdownEscaped(bodyWithoutDefinitions, match.index)) references.push(match[1]);
  }
  return { bodyWithoutDefinitions, definitions, references };
}

function markdownTargets(markdown: string): string[] {
  return [...new Set(markdownTargetOccurrences(markdown))];
}

function markdownTargetOccurrences(markdown: string): string[] {
  const targets: string[] = [];
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
  for (const match of withoutDefinitions.matchAll(inline)) targets.push(match[1] ?? match[2]);

  const fullReference = /(?<!!)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
  for (const match of withoutDefinitions.matchAll(fullReference)) {
    const target = definitions.get(referenceLabel(match[2] || match[1]));
    if (target) targets.push(target);
  }

  const shortcutReference = /(?<!!)\[([^\]\n]+)\](?![\[(:])/g;
  for (const match of withoutDefinitions.matchAll(shortcutReference)) {
    const target = definitions.get(referenceLabel(match[1]));
    if (target) targets.push(target);
  }

  return targets;
}

function isMarkdownEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
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

function mermaidProblems(body: string): MermaidProblem[] {
  const problems: MermaidProblem[] = [];
  const meaningful = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("%%"));
  const declaration = meaningful[0];
  let diagramType: string | undefined;
  if (!declaration) {
    problems.push({ code: "mermaid-syntax", message: "diagram is empty" });
  } else {
    const [declaredType, ...parameters] = declaration.split(/\s+/);
    diagramType = declaredType;
    if (diagramType === "flowchart") {
      if (parameters.length !== 1 || !MERMAID_FLOW_DIRECTIONS.has(parameters[0])) {
        problems.push({ code: "mermaid-syntax", message: "flowchart declaration requires one of: TB, TD, BT, RL, LR" });
      }
    } else if (!MERMAID_DIAGRAM_TYPES.has(diagramType) || parameters.length) {
      problems.push({
        code: "mermaid-syntax",
        message: "diagram declaration must be flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, or erDiagram",
      });
    }
  }

  const control = firstInvalidControl(body);
  if (control) problems.push({ code: "mermaid-syntax", message: `diagram contains an invalid control character on line ${control.line}` });
  if (/^\s*%%\{.*\}%%\s*$/m.test(body)) {
    problems.push({ code: "mermaid-policy", message: "Mermaid configuration directives are not allowed" });
  }
  if (/^\s*click\s+\S+/im.test(body)) {
    problems.push({ code: "mermaid-policy", message: "interactive Mermaid click actions are not allowed" });
  }
  if (containsUnsafeHtmlUrl(body)) {
    problems.push({ code: "mermaid-policy", message: "diagram contains an unsafe URL" });
  }
  if (MERMAID_EVENT_HANDLER.test(body)) {
    problems.push({ code: "mermaid-policy", message: "diagram contains an HTML event handler" });
  }
  return problems;
}

function containsUnsafeHtmlUrl(body: string): boolean {
  const attribute = /<[^>]+\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of body.matchAll(attribute)) {
    let value = match[1] ?? match[2] ?? match[3];
    value = value.replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal!, hex ? 16 : 10);
      return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    });
    value = value.replace(/&(colon|tab|newline);/gi, (entity) => {
      const name = entity.slice(1, -1).toLowerCase();
      return name === "colon" ? ":" : name === "tab" ? "\t" : "\n";
    });
    for (let round = 0; round < 3; round++) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        break;
      }
    }
    const canonical = value.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
    if (/^(?:javascript|vbscript|data):/.test(canonical)) return true;
  }
  return false;
}

function firstInvalidControl(body: string): { line: number } | undefined {
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) return { line: index + 1 };
  }
  return undefined;
}

function normalizeIndexText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function canonicalPageType(pageType: WikiSpecPage["pageType"]): string {
  return pageType[0].toUpperCase() + pageType.slice(1);
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_[\]{}#!|])/g, "\\$1");
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
