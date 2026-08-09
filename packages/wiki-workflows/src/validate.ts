import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { inside, markdownFiles, readText, writeText } from "./files.js";
import { parsePage } from "./frontmatter.js";
import type { WikiValidation } from "./types.js";
import { loadWikiWorkspace, type ResolvedWikiSource } from "./workspace.js";

const SOURCE_REFERENCE = /^([^\\/#][^#\\]*?)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;
const REPOSITORY_CITATION = /^repo:(.+)$/;
const MERMAID_DIRECTIVES = new Set([
  "flowchart",
  "graph",
  "sequencediagram",
  "classdiagram",
  "statediagram",
  "erdiagram",
  "journey",
  "gantt",
  "pie",
  "mindmap",
  "timeline",
  "quadrantchart",
  "requirementdiagram",
  "gitgraph",
  "xychart-beta",
]);

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

interface WorkspaceRoots {
  sources: Map<string, ResolvedWikiSource>;
  wiki: string;
  workspace: string;
}

/**
 * Finalize a generated Wiki in the configured workspace.
 *
 * Index files are generated before validation so writers never need to manage
 * navigation and a failed validation still leaves deterministic indexes behind.
 */
export async function validateWiki(root: string, wikiDirectory = "wiki"): Promise<WikiValidation> {
  if (wikiDirectory !== "wiki") {
    return { ok: false, errors: ["Wiki output is fixed at workspace-relative wiki/"], pages: [] };
  }

  let roots: WorkspaceRoots;
  try {
    const configured = await loadWikiWorkspace(root);
    const requestedWorkspace = path.resolve(configured.root);
    const workspace = await realpath(requestedWorkspace);
    const requestedWiki = inside(requestedWorkspace, path.join(requestedWorkspace, "wiki"));
    const wikiEntry = await lstat(requestedWiki);
    if (wikiEntry.isSymbolicLink()) {
      return { ok: false, errors: ["wiki directory must not be a symbolic link"], pages: [] };
    }
    if (!wikiEntry.isDirectory()) {
      return { ok: false, errors: ["wiki directory is not a directory: wiki"], pages: [] };
    }
    const wiki = await realpath(requestedWiki);
    inside(workspace, wiki);
    roots = { workspace, wiki, sources: new Map(configured.sources.map((source) => [source.path, source])) };
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)], pages: [] };
  }

  await regenerateIndexes(roots.wiki);
  const allPages = await markdownFiles(roots.wiki);
  const pages = allPages.filter((page) => path.posix.basename(page) !== "index.md");
  const errors: string[] = [];

  for (const page of pages) {
    const absolute = path.join(roots.wiki, page);
    let parsed: ReturnType<typeof parsePage>;
    try {
      parsed = parsePage(await readText(absolute));
    } catch (error) {
      errors.push(`${page}: ${errorMessage(error)}`);
      continue;
    }

    await validateFrontmatter(page, parsed.frontmatter, roots, errors);
    await validateBody(page, absolute, parsed.body, roots, errors);
  }

  return { ok: errors.length === 0, errors, pages };
}

async function regenerateIndexes(wikiRoot: string): Promise<void> {
  const writeIndex = async (directory: string, relative: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    const directories = entries.filter((entry) => entry.isDirectory());
    const pages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md");

    for (const child of directories) {
      await writeIndex(path.join(directory, child.name), relative ? `${relative}/${child.name}` : child.name);
    }

    const title = relative ? path.posix.basename(relative) : "Wiki";
    const lines = [`# ${title}`, ""];
    if (directories.length) {
      lines.push("## Directories", "", ...directories.map((entry) => `- [${entry.name}/](./${entry.name}/index.md)`), "");
    }
    if (pages.length) {
      lines.push("## Pages", "", ...pages.map((entry) => `- [${entry.name.replace(/\.md$/, "")}](./${entry.name})`), "");
    }
    await writeText(path.join(directory, "index.md"), `${lines.join("\n").replace(/\n+$/, "\n")}`);
  };

  await writeIndex(wikiRoot, "");
}

async function validateFrontmatter(page: string, frontmatter: Record<string, unknown>, roots: WorkspaceRoots, errors: string[]): Promise<void> {
  for (const field of ["type", "title", "description"] as const) {
    if (typeof frontmatter[field] !== "string" || !frontmatter[field].trim()) {
      errors.push(`${page}: frontmatter requires a non-empty ${field}`);
    }
  }

  const sources = frontmatter.sources;
  if (!Array.isArray(sources) || !sources.length || sources.some((source) => typeof source !== "string" || !source.trim())) {
    errors.push(`${page}: frontmatter sources must be a non-empty string array`);
    return;
  }

  for (const source of sources) {
    await validateSourceReference(page, source, roots, "frontmatter source", errors);
  }
}

async function validateBody(
  page: string,
  pageFile: string,
  body: string,
  roots: WorkspaceRoots,
  errors: string[],
): Promise<void> {
  for (const fence of mermaidFences(body)) {
    if (!fence.closed) {
      errors.push(`${page}: Mermaid fence opened on line ${fence.line} is not closed`);
      continue;
    }
    const issue = mermaidError(fence.body);
    if (issue) errors.push(`${page}: Mermaid fence on line ${fence.line} is invalid: ${issue}`);
  }

  for (const target of markdownTargets(body)) {
    const repositoryCitation = REPOSITORY_CITATION.exec(target);
    if (repositoryCitation) {
      if (!parseSourceReference(repositoryCitation[1])) {
        errors.push(`${page}: repo citation must be repo:<workspace-relative-path>#Lx-Ly: ${target}`);
        continue;
      }
      await validateSourceReference(page, repositoryCitation[1], roots, "repo citation", errors);
      continue;
    }
    if (target.startsWith("repo:")) {
      errors.push(`${page}: repo citation must be repo:<workspace-relative-path>#Lx-Ly: ${target}`);
      continue;
    }
    await validateInternalMarkdownLink(page, pageFile, target, roots.wiki, errors);
  }
}

async function validateSourceReference(page: string, reference: string, roots: WorkspaceRoots, label: string, errors: string[]): Promise<void> {
  const parsed = parseSourceReference(reference);
  if (!parsed) {
    errors.push(`${page}: ${label} must be workspace-relative with #Lx-Ly: ${reference}`);
    return;
  }
  if (parsed.end < parsed.start) {
    errors.push(`${page}: ${label} has an invalid line range: ${reference}`);
    return;
  }

  const [sourceName] = parsed.path.split("/", 1);
  const source = roots.sources.get(sourceName);
  if (!source) {
    errors.push(`${page}: ${label} must start with a declared source directory: ${reference}`);
    return;
  }

  let sourceFile: string;
  try {
    sourceFile = inside(roots.workspace, path.resolve(roots.workspace, parsed.path));
  } catch {
    errors.push(`${page}: ${label} escapes the workspace: ${reference}`);
    return;
  }

  await validateSourceFile(page, source, sourceFile, reference, label, parsed, errors);
}

async function validateSourceFile(
  page: string,
  source: ResolvedWikiSource,
  sourceFile: string,
  reference: string,
  label: string,
  range: SourceRange,
  errors: string[],
): Promise<void> {
  try {
    const physicalSource = await realpath(sourceFile);
    try {
      inside(source.realPath, physicalSource);
    } catch {
      errors.push(`${page}: ${label} resolves outside declared source ${source.path}: ${reference}`);
      return;
    }
    if (!(await stat(sourceFile)).isFile()) {
      errors.push(`${page}: ${label} does not name a file: ${reference}`);
      return;
    }
    if (lineCount(await readFile(sourceFile, "utf8")) < range.end) {
      errors.push(`${page}: ${label} line range exceeds file: ${reference}`);
    }
  } catch {
    errors.push(`${page}: ${label} file is missing: ${reference}`);
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

async function validateInternalMarkdownLink(page: string, pageFile: string, target: string, wikiRoot: string, errors: string[]): Promise<void> {
  if (!isInternalMarkdownLink(target)) return;
  const resource = target.split("#", 1)[0];
  let linkedFile: string;
  try {
    linkedFile = inside(wikiRoot, path.resolve(path.dirname(pageFile), resource));
  } catch {
    errors.push(`${page}: internal Markdown link escapes wiki/: ${target}`);
    return;
  }
  await validateLinkedFile(page, linkedFile, target, wikiRoot, errors);
}

async function validateLinkedFile(page: string, linkedFile: string, target: string, wikiRoot: string, errors: string[]): Promise<void> {
  try {
    const physicalLinkedFile = await realpath(linkedFile);
    try {
      inside(wikiRoot, physicalLinkedFile);
    } catch {
      errors.push(`${page}: internal Markdown link escapes wiki/: ${target}`);
      return;
    }
    if (!(await stat(linkedFile)).isFile()) errors.push(`${page}: internal Markdown link target is missing: ${target}`);
  } catch {
    errors.push(`${page}: internal Markdown link target is missing: ${target}`);
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
        targets.add(target);
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

function isInternalMarkdownLink(target: string): boolean {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return target.split("#", 1)[0].endsWith(".md");
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

function mermaidError(body: string): string | undefined {
  const meaningful = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("%%"));
  const directive = meaningful[0]?.split(/\s+/, 1)[0].toLowerCase();
  if (!directive) return "diagram is empty";
  if (!MERMAID_DIRECTIVES.has(directive)) return `unknown Mermaid diagram directive: ${directive}`;
  if ((directive === "flowchart" || directive === "graph") && (/(?:^|\n|\s)end\s*[[({]/.test(body) || /-->\s*end\s*(?:$|\n|;)/m.test(body))) {
    return "flowchart uses reserved word `end` as a node id";
  }
  if (/[[({][^)\]}]*;[^)\]}]*[)\]}]/.test(body)) return "diagram contains a semicolon inside a label";
  if (/\bclick\s+\S+\s+call\b/i.test(body)) return "interactive Mermaid callbacks are not allowed";
  if (/\b(?:javascript|data):/i.test(body)) return "diagram contains an unsafe URL";
  return undefined;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
