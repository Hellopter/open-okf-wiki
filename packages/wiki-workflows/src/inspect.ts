import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { exists, markdownFiles, readText } from "./files.js";
import { inside } from "./files.js";
import { parsePage } from "./frontmatter.js";
import { git, gitText, repositoryRoot } from "./git.js";
import type { SourceChange, WikiInspection, WikiMode } from "./types.js";

const WIKI_DIRECTORY = "wiki";
const SOURCE_REFERENCE = /^([^\\/#][^#\\]*?)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;

interface PageGraph {
  pages: string[];
  sources: Map<string, Set<string>>;
  inbound: Map<string, Set<string>>;
  reliable: boolean;
}

function isWikiPath(candidate: string): boolean {
  return candidate === WIKI_DIRECTORY || candidate.startsWith(`${WIKI_DIRECTORY}/`);
}

function normalizePath(candidate: string): string {
  return candidate.replaceAll("\\", "/");
}

function parseNameStatus(output: string): SourceChange[] {
  const fields = output.split("\0");
  const changes: SourceChange[] = [];

  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    if (!status) continue;
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(index, index + pathCount).map(normalizePath);
    index += pathCount;
    if (paths.length === pathCount && paths.every(Boolean)) changes.push({ status, paths });
  }

  return changes;
}

function parsePaths(output: string): string[] {
  return output.split("\0").filter(Boolean).map(normalizePath);
}

function uniqueChanges(changes: SourceChange[]): SourceChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.status}\0${change.paths.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function sourcePath(workspaceRoot: string, resource: string): Promise<string | null> {
  const match = SOURCE_REFERENCE.exec(resource);
  if (!match) return null;
  const source = match[1];
  const segments = source.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  if (end < start) return null;

  let sourceFile: string;
  try {
    sourceFile = inside(workspaceRoot, path.resolve(workspaceRoot, source));
    const physicalSource = await realpath(sourceFile);
    inside(workspaceRoot, physicalSource);
    if (!(await stat(physicalSource)).isFile()) return null;
    if (lineCount(await readFile(physicalSource, "utf8")) < end) return null;
  } catch {
    return null;
  }
  return source;
}

function markdownTargets(body: string): string[] {
  const targets: string[] = [];
  const link = /(?<!!)\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g;
  for (const match of body.matchAll(link)) {
    const target = match[1] ?? match[2];
    if (target) targets.push(target);
  }
  return targets;
}

function resolveWikiLink(from: string, target: string, pages: Set<string>): string | null {
  const location = target.split(/[?#]/, 1)[0]?.trim() ?? "";
  if (!location || location.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(location)) return null;

  let decoded = location;
  try {
    decoded = decodeURIComponent(location);
  } catch {
    return null;
  }

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) return null;
  const candidates = [resolved];
  if (resolved.endsWith("/")) candidates.push(`${resolved}index.md`);
  else if (!path.posix.extname(resolved)) candidates.push(`${resolved}.md`, `${resolved}/index.md`);
  return candidates.find((candidate) => pages.has(candidate)) ?? null;
}

async function inspectPageGraph(workspaceRoot: string, wikiRoot: string): Promise<PageGraph> {
  const allMarkdown = await markdownFiles(wikiRoot);
  const pages = allMarkdown.filter((relative) => path.posix.basename(relative) !== "index.md");
  const pageSet = new Set(pages);
  const sources = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();
  let reliable = pages.length > 0;

  for (const relative of pages) {
    let parsed;
    try {
      parsed = parsePage(await readText(path.join(wikiRoot, relative)));
    } catch {
      reliable = false;
      continue;
    }

    const resources = parsed.frontmatter.sources;
    if (!Array.isArray(resources) || !resources.length || resources.some((resource) => typeof resource !== "string" || !resource.trim())) {
      reliable = false;
      continue;
    }
    for (const resource of resources) {
      const source = await sourcePath(workspaceRoot, resource);
      if (!source) {
        reliable = false;
        continue;
      }
      const citedPages = sources.get(source) ?? new Set<string>();
      citedPages.add(relative);
      sources.set(source, citedPages);
    }

    for (const target of markdownTargets(parsed.body)) {
      const linkedPage = resolveWikiLink(relative, target, pageSet);
      if (!linkedPage) continue;
      const inboundPages = inbound.get(linkedPage) ?? new Set<string>();
      inboundPages.add(relative);
      inbound.set(linkedPage, inboundPages);
    }
  }

  return { pages, sources, inbound, reliable };
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

async function gitChanges(root: string, args: string[]): Promise<SourceChange[]> {
  const result = await git(root, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return parseNameStatus(result.stdout)
    .map((change) => ({ ...change, paths: change.paths.filter((candidate) => !isWikiPath(candidate)) }))
    .filter((change) => change.paths.length > 0);
}

async function untrackedChanges(root: string): Promise<SourceChange[]> {
  const result = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return parsePaths(result.stdout)
    .filter((candidate) => !isWikiPath(candidate))
    .map((candidate) => ({ status: "??", paths: [candidate] }));
}

async function hasWikiDrift(root: string): Promise<boolean> {
  const commands = [
    ["diff", "--name-only", "-z", "--", WIKI_DIRECTORY],
    ["diff", "--cached", "--name-only", "-z", "--", WIKI_DIRECTORY],
    ["ls-files", "--others", "--exclude-standard", "-z", "--", WIKI_DIRECTORY],
  ];
  const results = await Promise.all(commands.map((args) => git(root, args)));
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr.trim() || "failed to inspect wiki drift");
    if (parsePaths(result.stdout).some(isWikiPath)) return true;
  }
  return false;
}

function impactedPages(graph: PageGraph, changedPaths: string[]): string[] {
  const impacted = new Set<string>();
  for (const changed of changedPaths) {
    for (const page of graph.sources.get(changed) ?? []) impacted.add(page);
  }

  const queue = [...impacted];
  while (queue.length) {
    const page = queue.shift()!;
    for (const inbound of graph.inbound.get(page) ?? []) {
      if (impacted.has(inbound)) continue;
      impacted.add(inbound);
      queue.push(inbound);
    }
  }

  return [...impacted].sort();
}

/**
 * Inspect the current Git worktree without creating snapshots or state files.
 * A `generate` result means the caller must rebuild the whole Wiki; `refresh`
 * carries only the pages that can be safely updated incrementally.
 */
export async function inspectWiki(cwd: string): Promise<WikiInspection> {
  const root = await repositoryRoot(cwd);
  const workspaceRoot = await realpath(root);
  const headResult = await git(root, ["rev-parse", "HEAD"]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";
  const wikiRoot = path.join(root, WIKI_DIRECTORY);
  const wikiExists = await exists(wikiRoot);
  const lastWikiCommit = head
    ? await git(root, ["log", "-1", "--format=%H", "--", WIKI_DIRECTORY]).then((result) => {
      if (result.code !== 0) throw new Error(result.stderr.trim() || "failed to find the last Wiki commit");
      return result.stdout.trim() || null;
    })
    : null;
  const baseCommit = lastWikiCommit && head
    ? await gitText(root, ["merge-base", lastWikiCommit, head])
    : null;

  const committed = baseCommit ? await gitChanges(root, ["diff", "--name-status", "-z", baseCommit, "HEAD"]) : [];
  const staged = await gitChanges(root, ["diff", "--cached", "--name-status", "-z"]);
  const unstaged = await gitChanges(root, ["diff", "--name-status", "-z"]);
  const untracked = await untrackedChanges(root);
  const changed = uniqueChanges([...committed, ...staged, ...unstaged, ...untracked]);
  const changedPaths = [...new Set(changed.flatMap((change) => change.paths).filter((candidate) => !isWikiPath(candidate)))].sort();
  const wikiDrift = await hasWikiDrift(root);
  const graph = wikiExists ? await inspectPageGraph(workspaceRoot, wikiRoot) : { pages: [], sources: new Map(), inbound: new Map(), reliable: true };

  const mode: WikiMode = lastWikiCommit && wikiExists && !wikiDrift && graph.reliable ? "refresh" : "generate";
  return {
    root,
    wikiRoot,
    mode,
    head,
    baseCommit,
    lastWikiCommit,
    changed,
    changedPaths,
    impactedPages: mode === "refresh" ? impactedPages(graph, changedPaths) : graph.pages,
    wikiDrift,
  };
}
