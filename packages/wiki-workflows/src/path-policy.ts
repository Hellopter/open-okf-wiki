/**
 * Workspace path policy and handoff-artifact I/O.
 *
 * Shared by agent-tools (tool wiring) and agent-submissions (submit/write tools)
 * so those modules stay free of a circular import.
 *
 * Pure of agent tool definitions; depends only on workspace + control size limits.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_CONTROL_ARTIFACT_BYTES,
  MAX_RESEARCH_ARTIFACT_BYTES,
  WikiControlSubmissionSizeError,
} from "./control-submissions.js";
import { loadWikiWorkspace } from "./workspace.js";

export interface WorkspaceToolPolicy {
  workspaceRoot: string;
  sourceRoots: Map<string, PermittedToolRoot>;
  wikiRoot: string;
  /** Optional unpublished Wiki root used by writer/reviewer tools for this run. */
  candidateWikiRoot?: string;
  artifactRoot: string;
}

export interface PermittedToolRoot {
  logicalRoot: string;
  physicalRoot?: string;
}

export async function workspaceToolPolicy(cwd: string, candidateWikiRoot?: string): Promise<WorkspaceToolPolicy> {
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
  return {
    workspaceRoot: workspace.root,
    sourceRoots,
    wikiRoot: path.join(workspace.root, "wiki"),
    candidateWikiRoot: resolvedCandidateRoot,
    // Parent of runs/ (staging + per-run manifests) and blobs/ (content-addressed handoffs).
    artifactRoot: path.join(workspace.root, ".okf-wiki"),
  };
}

export function resolveArtifactPath(policy: WorkspaceToolPolicy, rawPath: string): string {
  if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid artifact path");
  const artifactPath = insideWorkspace(policy.workspaceRoot, rawPath);
  const artifactRoot = path.resolve(policy.artifactRoot);
  if (artifactPath === artifactRoot || !pathIsInside(artifactRoot, artifactPath) || ![".json", ".md"].includes(path.extname(artifactPath))) {
    throw new Error(`Workflow configuration error: artifact path must be a Markdown or JSON file under .okf-wiki: ${rawPath}`);
  }
  return path.resolve(artifactPath);
}

export async function readArtifactText(policy: WorkspaceToolPolicy, artifactPath: string): Promise<string> {
  const expectedPath = resolveArtifactPath(policy, artifactPath);
  const expectedEntry = await lstat(expectedPath);
  if (expectedEntry.isSymbolicLink() || !expectedEntry.isFile()) {
    throw new Error(`Handoff artifact must be a regular file: ${artifactPath}`);
  }
  const resolvedPath = await assertAllowedWorkspacePath(
    policy.workspaceRoot,
    [{ logicalRoot: policy.artifactRoot }],
    expectedPath,
    false,
  );
  const entry = await lstat(resolvedPath);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Handoff artifact must be a regular file: ${artifactPath}`);
  if (entry.size > MAX_CONTROL_ARTIFACT_BYTES) {
    throw new WikiControlSubmissionSizeError("Handoff artifact", entry.size, MAX_CONTROL_ARTIFACT_BYTES);
  }
  const bytes = await readFile(resolvedPath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Handoff artifact must be valid UTF-8");
  }
}

export async function writeArtifactText(policy: WorkspaceToolPolicy, artifactPath: string, content: string): Promise<void> {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  const limitBytes = path.extname(artifactPath) === ".md" ? MAX_RESEARCH_ARTIFACT_BYTES : MAX_CONTROL_ARTIFACT_BYTES;
  if (sizeBytes > limitBytes) {
    throw new WikiControlSubmissionSizeError("Handoff artifact", sizeBytes, limitBytes);
  }
  await ensureArtifactRoot(policy);
  const resolvedPath = await assertAllowedWorkspacePath(
    policy.workspaceRoot,
    [{ logicalRoot: policy.artifactRoot }],
    artifactPath,
    true,
  );
  const existingEntry = await lstat(resolvedPath).catch((error: unknown) => {
    if (isMissingPath(error)) return undefined;
    throw error;
  });
  if (existingEntry?.isSymbolicLink() || (existingEntry && !existingEntry.isFile())) {
    throw new Error(`Handoff artifact must be a regular file: ${artifactPath}`);
  }
  await assertContainedAbsolutePath(policy.artifactRoot, resolvedPath, true, "artifact root");
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await assertContainedAbsolutePath(policy.artifactRoot, resolvedPath, true, "artifact root");
  const temporaryPath = path.join(path.dirname(resolvedPath), `.${path.basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, resolvedPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function ensureArtifactRoot(policy: WorkspaceToolPolicy): Promise<void> {
  await assertAllowedWorkspacePath(
    policy.workspaceRoot,
    [{ logicalRoot: policy.workspaceRoot }],
    policy.artifactRoot,
    true,
  );
  await mkdir(policy.artifactRoot, { recursive: true });
  const entry = await lstat(policy.artifactRoot);
  if (!entry.isDirectory()) throw new Error("Workflow artifact root must be a directory");
  await assertContainedAbsolutePath(policy.workspaceRoot, policy.artifactRoot, false, "workspace root");
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
  if (!permitted) throw new Error(`Path is outside the permitted workspace scope: ${candidate}`);

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
