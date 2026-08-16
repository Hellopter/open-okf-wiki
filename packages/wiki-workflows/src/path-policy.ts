/** Workspace path policy for guarded model filesystem tools. */
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { loadWikiWorkspace } from "./workspace.js";
import type { WikiPinnedSourcePlan } from "./runtime-types.js";

export interface WorkspaceToolPolicy {
  workspaceRoot: string;
  sourceRoots: Map<string, PermittedToolRoot>;
  wikiRoot: string;
  /** Optional unpublished Wiki root used by writer/reviewer tools for this run. */
  candidateWikiRoot?: string;
  /** Optional materialized production skill; read-only for every role. */
  skillRoot?: string;
}

export interface PermittedToolRoot {
  logicalRoot: string;
  physicalRoot?: string;
}

export async function workspaceToolPolicy(cwd: string, candidateWikiRoot?: string, skillRoot?: string): Promise<WorkspaceToolPolicy> {
  const workspace = await loadWikiWorkspace(cwd);
  const sourceRoots = new Map(workspace.sources.map((source) => [
    source.path,
    { logicalRoot: source.absolutePath, physicalRoot: source.realPath } satisfies PermittedToolRoot,
  ]));
  const resolvedCandidateRoot = candidateWikiRoot === undefined
    ? undefined
    : insideWorkspace(workspace.root, candidateWikiRoot);
  if (resolvedCandidateRoot === path.resolve(workspace.root)) {
    throw new Error("Workflow configuration error: candidate Wiki root must be a workspace subdirectory");
  }
  const resolvedSkillRoot = skillRoot === undefined
    ? undefined
    : insideWorkspace(workspace.root, skillRoot);
  if (resolvedSkillRoot === path.resolve(workspace.root)) {
    throw new Error("Workflow configuration error: production skill root must be a workspace subdirectory");
  }
  return {
    workspaceRoot: workspace.root,
    sourceRoots,
    wikiRoot: path.join(workspace.root, "wiki"),
    candidateWikiRoot: resolvedCandidateRoot,
    skillRoot: resolvedSkillRoot,
  };
}

/** Build the Agent filesystem policy only from the production plan pinned at run start. */
export function pinnedWorkspaceToolPolicy(
  plan: WikiPinnedSourcePlan,
  candidateWikiRoot?: string,
  skillRoot?: string,
): WorkspaceToolPolicy {
  const workspaceRoot = path.resolve(plan.workspaceRoot);
  const sourceRoots = new Map(plan.sources.map((source) => [
    source.scopeId,
    {
      logicalRoot: insideWorkspace(workspaceRoot, source.absolutePath),
      physicalRoot: path.resolve(source.realPath),
    } satisfies PermittedToolRoot,
  ]));
  const resolvedCandidateRoot = candidateWikiRoot === undefined ? undefined : insideWorkspace(workspaceRoot, candidateWikiRoot);
  const resolvedSkillRoot = skillRoot === undefined ? undefined : insideWorkspace(workspaceRoot, skillRoot);
  if (resolvedCandidateRoot === workspaceRoot) throw new Error("Workflow configuration error: candidate Wiki root must be a workspace subdirectory");
  if (resolvedSkillRoot === workspaceRoot) throw new Error("Workflow configuration error: production skill root must be a workspace subdirectory");
  return {
    workspaceRoot,
    sourceRoots,
    wikiRoot: path.join(workspaceRoot, "wiki"),
    ...(resolvedCandidateRoot ? { candidateWikiRoot: resolvedCandidateRoot } : {}),
    ...(resolvedSkillRoot ? { skillRoot: resolvedSkillRoot } : {}),
  };
}

/** Resolve candidate under workspace root; throw if it escapes. */
export function insideWorkspace(root: string, candidate: string): string {
  const absolute = path.resolve(root, candidate);
  if (!pathIsInside(path.resolve(root), absolute)) throw new Error(`Path is outside the workspace: ${candidate}`);
  return absolute;
}

/**
 * True when `target` is under `root`, including equality.
 * (Distinct from util.pathIsInside, which is strict / non-equal.)
 */
export function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function assertAllowedWorkspacePath(
  workspaceRoot: string,
  permittedRoots: PermittedToolRoot[],
  candidate: string,
  allowMissing: boolean,
): Promise<string> {
  const absolute = insideWorkspace(workspaceRoot, candidate);
  const permitted = permittedRoots
    .filter((root) => pathIsInside(path.resolve(root.logicalRoot), absolute))
    .sort((left, right) => path.resolve(right.logicalRoot).length - path.resolve(left.logicalRoot).length)[0];
  if (!permitted) {
    const roots = permittedRoots.map((root) => cwdRelativeRoot(workspaceRoot, root.logicalRoot));
    throw new Error(`Path is outside the permitted workspace scope: ${candidate}. Permitted roots: ${roots.join(", ") || "(none)"}`);
  }

  const permittedPhysical = permitted.physicalRoot ?? await realpath(permitted.logicalRoot).catch(() => path.resolve(permitted.logicalRoot));
  let existing = absolute;
  while (true) {
    try {
      const physical = await realpath(existing);
      if (pathIsInside(permittedPhysical, physical)) return absolute;
      if (allowMissing && !(await pathExists(permitted.logicalRoot))) return absolute;
      throw new Error(`Path escapes the permitted workspace scope: ${candidate}`);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`Path escapes the permitted workspace scope: ${candidate}`);
      if (!allowMissing && existing === absolute) throw error;
      existing = parent;
    }
  }
}

export async function assertContainedAbsolutePath(root: string, candidate: string, allowMissing: boolean, rootLabel = "Wiki root"): Promise<string> {
  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const absolute = path.resolve(candidate);
  assertPathPrefix(rootReal, absolute, rootLabel);

  let existing = absolute;
  while (true) {
    let real: string;
    try {
      real = await realpath(existing);
    } catch (error) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error(`Path escapes the ${rootLabel}: ${candidate}`);
      }
      if (!allowMissing && existing === absolute) throw error;
      existing = parent;
      continue;
    }
    // Do not catch this containment failure as though the entry were missing.
    assertPathPrefix(rootReal, real, rootLabel);
    return absolute;
  }
}

export async function ensureWikiRoot(root: string): Promise<void> {
  const requested = path.resolve(root);
  await mkdir(requested, { recursive: true });
  const physical = await realpath(requested);
  assertPathPrefix(requested, physical);
}

export function assertPathPrefix(root: string, target: string, rootLabel = "Wiki root"): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Path escapes the ${rootLabel}: ${target}`);
}

export async function pathExists(location: string): Promise<boolean> {
  try {
    await lstat(location);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

export function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

export function cwdRelativeRoot(workspaceRoot: string, target: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(target)).split(path.sep).join("/");
  return relative === "" ? "." : relative;
}
