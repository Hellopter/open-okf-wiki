import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { WikiResearchArtifact } from "./workflow-types.js";
import { loadWikiWorkspace } from "./workspace.js";

/** Declared source root with logical workspace path and physical realpath. */
export interface ResearchSourceRoot {
  path: string;
  logicalRoot: string;
  physicalRoot: string;
}

export interface ValidateResearchArtifactOptions {
  cwd: string;
  /** Scope-authorized source roots (e.g. research scope.sourcePaths). */
  allowedSourceRoots: readonly string[];
  /** Optional pre-resolved roots; when omitted, resolved under cwd / workspace. */
  sourceRoots?: readonly ResearchSourceRoot[];
  excludedPaths?: readonly string[];
}

/**
 * Resolve symlink-safe source roots for research validation.
 * Prefer workspace-declared absolute/real paths so engine and submit agree.
 */
export async function loadResearchSourceRoots(
  cwd: string,
  allowedSourceRoots: readonly string[],
): Promise<ResearchSourceRoot[]> {
  const allowed = uniqueSorted(allowedSourceRoots);
  if (allowed.length === 0) return [];
  try {
    const workspace = await loadWikiWorkspace(cwd);
    const byPath = new Map(workspace.sources.map((source) => [source.path, source]));
    return allowed.map((sourcePath) => {
      const configured = byPath.get(sourcePath);
      if (configured) {
        return {
          path: sourcePath,
          logicalRoot: configured.absolutePath,
          physicalRoot: configured.realPath,
        };
      }
      return resolveSourceRootFromCwd(cwd, sourcePath);
    });
  } catch {
    return allowed.map((sourcePath) => resolveSourceRootFromCwd(cwd, sourcePath));
  }
}

function resolveSourceRootFromCwd(cwd: string, sourcePath: string): ResearchSourceRoot {
  const logicalRoot = path.resolve(cwd, ...sourcePath.split("/"));
  let physicalRoot: string;
  try {
    physicalRoot = realpathSync(logicalRoot);
  } catch {
    throw new Error(`Assigned research source root does not exist: ${sourcePath}`);
  }
  return { path: sourcePath, logicalRoot, physicalRoot };
}

export interface ParsedEvidenceReference {
  path: string;
  start: number;
  end: number;
  raw: string;
}

/** Parse a research evidence string `project/path#Lx` or `project/path#Lx-Ly`. */
export function parseEvidenceReference(value: string, label = "Research finding evidence"): ParsedEvidenceReference {
  const reference = value.trim();
  const match = /^([^#\s]+)#L([1-9][0-9]*)(?:-L([1-9][0-9]*))?$/.exec(reference);
  if (!match || match[1]!.startsWith("/") || match[1]!.includes("\\")) {
    throw new Error(`${label} is invalid: ${reference}`);
  }
  if (match[1]!.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} is invalid: ${reference}`);
  }
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  if (end < start) throw new Error(`${label} has an invalid line range: ${reference}`);
  return { path: match[1]!, start, end, raw: reference };
}

/**
 * Validate every finding evidence range and gap source path against the assigned
 * scope and the filesystem. Throws with a specific, model-actionable message.
 */
export function validateResearchArtifact(
  artifact: WikiResearchArtifact,
  options: ValidateResearchArtifactOptions,
): void {
  const allowed = uniqueSorted(options.allowedSourceRoots);
  if (allowed.length === 0) throw new Error("Research validation requires at least one allowed source root");
  const roots = resolveSourceRoots(options.cwd, allowed, options.sourceRoots);
  const issues: string[] = [];

  for (const [index, finding] of artifact.findings.entries()) {
    for (const evidence of finding.evidence) {
      try {
        const parsed = parseEvidenceReference(evidence);
        if (options.excludedPaths?.some((pattern) => matchesPathGlob(parsed.path, pattern))) {
          throw new Error(`Research evidence targets a path excluded by workspace policy: ${evidence}`);
        }
        validateEvidenceRange(evidence, allowed, roots, options.cwd);
      } catch (error) {
        issues.push(`findings[${index}]: ${errorMessage(error)}`);
      }
    }
  }
  for (const [index, gap] of artifact.gaps.entries()) {
    for (const sourcePath of gap.sourcePaths) {
      if (!allowed.includes(sourcePath)) {
        issues.push(`gaps[${index}]: Research gap source path is outside the assigned scope: ${sourcePath}`);
      }
    }
  }
  if (issues.length) throw new Error(issues.join("\n"));
}

function matchesPathGlob(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function validateEvidenceRange(
  evidence: string,
  allowed: readonly string[],
  roots: Map<string, ResearchSourceRoot>,
  cwd: string,
): void {
  let parsed: ParsedEvidenceReference;
  try {
    parsed = parseEvidenceReference(evidence);
  } catch (error) {
    throw new Error(errorMessage(error));
  }
  const sourceRootPath = matchingSourceRoot(parsed.path, allowed);
  if (!sourceRootPath) {
    throw new Error(`Research evidence is outside the assigned scope: ${evidence}`);
  }
  const root = roots.get(sourceRootPath);
  if (!root) {
    throw new Error(`Research evidence source root is unavailable: ${sourceRootPath}`);
  }

  let sourceFile: string;
  let physicalFile: string;
  try {
    sourceFile = path.resolve(cwd, ...parsed.path.split("/"));
    if (!pathIsInside(path.resolve(root.logicalRoot), sourceFile) && !pathIsInside(path.resolve(cwd, sourceRootPath), sourceFile)) {
      throw new Error("escapes logical root");
    }
    physicalFile = realpathSync(sourceFile);
  } catch {
    throw new Error(`Research evidence file is missing: ${evidence}`);
  }

  if (!pathIsInside(root.physicalRoot, physicalFile)) {
    throw new Error(`Research evidence path escapes source root ${sourceRootPath}: ${evidence}`);
  }
  let isFile = false;
  try {
    isFile = statSync(physicalFile).isFile();
  } catch {
    throw new Error(`Research evidence file is missing: ${evidence}`);
  }
  if (!isFile) throw new Error(`Research evidence does not name a file: ${evidence}`);

  const lines = lineCount(readFileSync(physicalFile, "utf8"));
  if (parsed.start > lines || parsed.end > lines) {
    throw new Error(`Research evidence line range exceeds file (${lines} lines): ${evidence}`);
  }
}

/** Longest-prefix match against declared source roots. */
export function matchingSourceRoot(filePath: string, roots: readonly string[]): string | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  return [...roots]
    .filter((root) => root.length > 0)
    .sort((left, right) => right.length - left.length)
    .find((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function resolveSourceRoots(
  cwd: string,
  allowed: readonly string[],
  provided?: readonly ResearchSourceRoot[],
): Map<string, ResearchSourceRoot> {
  const map = new Map<string, ResearchSourceRoot>();
  if (provided?.length) {
    for (const root of provided) map.set(root.path, root);
  }
  for (const sourcePath of allowed) {
    if (map.has(sourcePath)) continue;
    const logicalRoot = path.resolve(cwd, ...sourcePath.split("/"));
    let physicalRoot: string;
    try {
      physicalRoot = realpathSync(logicalRoot);
    } catch {
      throw new Error(`Assigned research source root does not exist: ${sourcePath}`);
    }
    map.set(sourcePath, { path: sourcePath, logicalRoot, physicalRoot });
  }
  return map;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
