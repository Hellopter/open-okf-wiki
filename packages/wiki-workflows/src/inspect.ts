import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { exists, inside, markdownFiles, readText } from "./files.js";
import { parsePage } from "./frontmatter.js";
import { git } from "./git.js";
import type { SourceChange, WikiInspection, WikiMode } from "./types.js";
import { loadWikiWorkspace, sourceIsIgnored, type ResolvedWikiSource, type ResolvedWikiWorkspace } from "./workspace.js";

const WIKI_DIRECTORY = "wiki";
const SOURCE_REFERENCE = /^([^\\/#][^#\\]*?)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;

interface PageGraph {
  pages: string[];
  sources: Map<string, Set<string>>;
  inbound: Map<string, Set<string>>;
  reliable: boolean;
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

function workspacePath(source: ResolvedWikiSource, relative: string): string {
  return relative ? `${source.path}/${relative}` : source.path;
}

async function sourcePath(workspace: ResolvedWikiWorkspace, resource: string): Promise<string | null> {
  const match = SOURCE_REFERENCE.exec(resource);
  if (!match) return null;
  const source = match[1];
  const segments = source.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const configured = workspace.sources.find((candidate) => source === candidate.path || source.startsWith(`${candidate.path}/`));
  if (!configured || source === configured.path) return null;
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  if (end < start) return null;

  try {
    const sourceFile = inside(workspace.root, path.resolve(workspace.root, source));
    const physicalSource = await realpath(sourceFile);
    inside(configured.realPath, physicalSource);
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

async function inspectPageGraph(workspace: ResolvedWikiWorkspace, wikiRoot: string): Promise<PageGraph> {
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
      const source = await sourcePath(workspace, resource);
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

async function gitChanges(root: string, args: string[], source: ResolvedWikiSource, defaultsEnabled: boolean): Promise<SourceChange[]> {
  const result = await git(root, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return parseNameStatus(result.stdout)
    .map((change) => ({ ...change, paths: change.paths.filter((candidate) => !sourceIsIgnored(source, candidate, defaultsEnabled)) }))
    .filter((change) => change.paths.length > 0);
}

async function untrackedChanges(root: string, source: ResolvedWikiSource, defaultsEnabled: boolean): Promise<SourceChange[]> {
  const result = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  return parsePaths(result.stdout)
    .filter((candidate) => !sourceIsIgnored(source, candidate, defaultsEnabled))
    .map((candidate) => ({ status: "??", paths: [candidate] }));
}

async function sourceState(source: ResolvedWikiSource, defaultsEnabled: boolean): Promise<{ head: string; changes: SourceChange[]; fingerprint: string }> {
  const headResult = await git(source.repositoryRoot, ["rev-parse", "HEAD"]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";
  const staged = await gitChanges(source.repositoryRoot, ["diff", "--cached", "--name-status", "-z"], source, defaultsEnabled);
  const unstaged = await gitChanges(source.repositoryRoot, ["diff", "--name-status", "-z"], source, defaultsEnabled);
  const untracked = await untrackedChanges(source.repositoryRoot, source, defaultsEnabled);
  const changes = uniqueChanges([...staged, ...unstaged, ...untracked]);
  const hash = createHash("sha256");
  hash.update(source.path);
  hash.update("\0");
  hash.update(head);
  for (const change of [...changes].sort((left, right) => `${left.status}\0${left.paths.join("\0")}`.localeCompare(`${right.status}\0${right.paths.join("\0")}`))) {
    hash.update(change.status);
    hash.update("\0");
    for (const relative of change.paths) {
      hash.update(relative);
      hash.update("\0");
      try {
        hash.update(await readFile(path.join(source.realPath, relative)));
      } catch {
        hash.update("missing");
      }
      hash.update("\0");
    }
  }
  return { head, changes, fingerprint: hash.digest("hex") };
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

/** Inspect declared Git sources without copying them into workspace state. */
export async function inspectWiki(cwd: string): Promise<WikiInspection> {
  const workspace = await loadWikiWorkspace(cwd);
  if (workspace.sources.length === 0) throw new Error("workspace.yaml has no sources. Run /wiki source add first.");
  const wikiRoot = path.join(workspace.root, WIKI_DIRECTORY);
  const wikiExists = await exists(wikiRoot);
  const states = await Promise.all(workspace.sources.map(async (source) => ({ source, ...await sourceState(source, workspace.defaultSourceIgnores) })));
  const changed = uniqueChanges(states.flatMap(({ source, changes }) => changes.map((change) => ({
    ...change,
    paths: change.paths.map((relative) => workspacePath(source, relative)),
  }))));
  const changedPaths = [...new Set(changed.flatMap((change) => change.paths))].sort();
  const graph = wikiExists ? await inspectPageGraph(workspace, wikiRoot) : { pages: [], sources: new Map(), inbound: new Map(), reliable: false };
  const directlyImpactedPages = impactedPages(graph, changedPaths);
  // A plain workspace has no trusted cross-repository generation baseline. A
  // current Git diff can safely drive refresh only when valid citations map it
  // to existing pages. All other states rebuild rather than risk stale prose.
  const mode: WikiMode = wikiExists && graph.reliable && changedPaths.length > 0 && directlyImpactedPages.length > 0
    ? "refresh"
    : "generate";
  const sourceFingerprint = createHash("sha256").update(states.map(({ fingerprint }) => fingerprint).sort().join("\0")).digest("hex");
  const head = states.map(({ source, head }) => `${source.path}:${head}`).sort().join(",");
  return {
    root: workspace.root,
    wikiRoot,
    sourcePaths: workspace.sources.map((source) => source.path).sort(),
    mode,
    head,
    baseCommit: null,
    lastWikiCommit: null,
    changed,
    changedPaths,
    sourceFingerprint,
    existingPages: [...graph.pages].sort(),
    impactedPages: mode === "refresh" ? directlyImpactedPages : graph.pages,
    wikiDrift: false,
  };
}
