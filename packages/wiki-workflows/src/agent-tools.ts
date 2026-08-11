import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  MAX_CONTROL_ARTIFACT_BYTES,
  MAX_RESEARCH_ARTIFACT_BYTES,
  WikiControlSubmissionSizeError,
} from "./control-submissions.js";
import {
  createArtifactWriteToolDefinition,
  submissionTool,
  type SubmissionCollector,
} from "./agent-submissions.js";
import { boundToolExecutionResult } from "./tool-budget.js";
import type { WikiAgentExecutionRequest } from "./workflow-types.js";
import { loadWikiWorkspace } from "./workspace.js";

export interface WorkspaceToolPolicy {
  workspaceRoot: string;
  sourceRoots: Map<string, PermittedToolRoot>;
  wikiRoot: string;
  artifactRoot: string;
}

export interface PermittedToolRoot {
  logicalRoot: string;
  physicalRoot?: string;
}

export async function workspaceToolPolicy(cwd: string): Promise<WorkspaceToolPolicy> {
  const workspace = await loadWikiWorkspace(cwd);
  const sourceRoots = new Map(workspace.sources.map((source) => [
    source.path,
    { logicalRoot: source.absolutePath, physicalRoot: source.realPath } satisfies PermittedToolRoot,
  ]));
  return {
    workspaceRoot: workspace.root,
    sourceRoots,
    wikiRoot: path.join(workspace.root, "wiki"),
    artifactRoot: path.join(workspace.root, ".okf-wiki", "runs"),
  };
}

export function workflowTools(
  policy: WorkspaceToolPolicy,
  role: WikiAgentExecutionRequest["role"],
  submission?: SubmissionCollector,
  writePaths?: readonly string[],
  readRoots?: readonly string[],
  artifactPaths?: readonly string[],
  wikiReadPaths?: readonly string[],
  artifactWritePath?: string,
): ToolDefinition<any, any, any>[] {
  const allowedPaths = role === "writer" ? exactWriterPaths(policy, writePaths) : undefined;
  const readableRoots = readRootsForPolicy(policy, readRoots, artifactPaths, wikiReadPaths, allowedPaths);
  const readOnly = [
    boundSurveyTool(guardWorkspaceTool(createReadToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"), "read"),
    boundSurveyTool(guardWorkspaceTool(createGrepToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"), "grep"),
    boundSurveyTool(guardWorkspaceTool(createFindToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"), "find"),
    boundSurveyTool(guardWorkspaceTool(createLsToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"), "ls"),
  ];
  const artifactWriter = artifactWritePath
    ? createArtifactWriteToolDefinition(policy, artifactWritePath, submission?.toolName)
    : undefined;
  if (role !== "writer") {
    return [
      ...readOnly,
      ...(artifactWriter ? [artifactWriter] : []),
      ...(submission ? [submissionTool(policy, submission, { allowedSourceRoots: readRoots ?? [] })] : []),
    ];
  }

  if (!allowedPaths) throw new Error("Workflow configuration error: writers require assigned Wiki pages");
  const allowedDirectories = writerDirectories(policy.wikiRoot, allowedPaths);

  const write = createWriteToolDefinition(policy.workspaceRoot, {
    operations: {
      mkdir: async (directory) => await guardedMkdir(policy.wikiRoot, directory, allowedDirectories),
      writeFile: async (file, content) => await guardedWrite(policy.wikiRoot, file, content, allowedPaths),
    },
  });
  const edit = createEditToolDefinition(policy.workspaceRoot, {
    operations: {
      access: async (file) => await guardedAccess(policy.wikiRoot, file, allowedPaths),
      readFile: async (file) => await guardedRead(policy.wikiRoot, file, allowedPaths),
      writeFile: async (file, content) => await guardedWrite(policy.wikiRoot, file, content, allowedPaths),
    },
  });
  return [
    ...readOnly,
    // Inputs are resolved by Pi's built-in definitions against the workspace.
    // The guarded operations below receive those absolute paths and enforce wiki/.
    guardWorkspaceTool(edit, policy.workspaceRoot, [{ logicalRoot: policy.wikiRoot }], "path"),
    guardWorkspaceTool(write, policy.workspaceRoot, [{ logicalRoot: policy.wikiRoot }], "path", true),
    ...(submission ? [submissionTool(policy, submission, { allowedSourceRoots: readRoots ?? [] })] : []),
  ];
}

function boundSurveyTool(
  definition: ToolDefinition<any, any, any>,
  toolName: string,
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const result = await execute(toolCallId, params, signal, onUpdate, context);
      return boundToolExecutionResult(result, toolName);
    },
  } as ToolDefinition<any, any, any>;
}

function readRootsForPolicy(
  policy: WorkspaceToolPolicy,
  requested: readonly string[] | undefined,
  artifactPaths: readonly string[] | undefined,
  wikiReadPaths: readonly string[] | undefined,
  writerPaths: ReadonlySet<string> | undefined,
): PermittedToolRoot[] {
  const roots: PermittedToolRoot[] = [];
  for (const sourcePath of requested ?? []) {
    const root = policy.sourceRoots.get(sourcePath);
    if (!root) throw new Error(`Workflow configuration error: undeclared source root: ${sourcePath}`);
    roots.push(root);
  }
  for (const artifactPath of artifactPaths ?? []) roots.push(exactArtifactReadRoot(policy, artifactPath));
  for (const wikiReadPath of wikiReadPaths ?? []) roots.push(exactWikiReadRoot(policy, wikiReadPath));
  for (const writerPath of writerPaths ?? []) roots.push(exactWorkspaceFileRoot(writerPath));
  if (roots.length === 0) throw new Error("Workflow configuration error: agent requests require declared source roots or exact artifact paths");
  return roots;
}

function exactArtifactReadRoot(policy: WorkspaceToolPolicy, artifactPath: string): PermittedToolRoot {
  return exactWorkspaceFileRoot(resolveArtifactPath(policy, artifactPath));
}

function exactWikiReadRoot(policy: WorkspaceToolPolicy, rawPath: string): PermittedToolRoot {
  if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid Wiki read path");
  const wikiReadPath = insideWorkspace(policy.workspaceRoot, rawPath);
  if (!pathIsInside(path.resolve(policy.wikiRoot), wikiReadPath) || !wikiReadPath.endsWith(".md")) {
    throw new Error(`Workflow configuration error: Wiki read path must be a Markdown file under wiki/: ${rawPath}`);
  }
  return exactWorkspaceFileRoot(wikiReadPath);
}

/** Exact workflow files must not acquire a different physical root via symlink. */
function exactWorkspaceFileRoot(file: string): PermittedToolRoot {
  const resolved = path.resolve(file);
  return { logicalRoot: resolved, physicalRoot: resolved };
}

export function resolveArtifactPath(policy: WorkspaceToolPolicy, rawPath: string): string {
  if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid artifact path");
  const artifactPath = insideWorkspace(policy.workspaceRoot, rawPath);
  const artifactRoot = path.resolve(policy.artifactRoot);
  if (artifactPath === artifactRoot || !pathIsInside(artifactRoot, artifactPath) || ![".json", ".md"].includes(path.extname(artifactPath))) {
    throw new Error(`Workflow configuration error: artifact path must be a Markdown or JSON file under .okf-wiki/runs: ${rawPath}`);
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

function guardWorkspaceTool(
  definition: ToolDefinition<any, any, any>,
  workspaceRoot: string,
  permittedRoots: PermittedToolRoot[],
  pathField: string,
  allowMissing = false,
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const rawPath = valueAt(params, pathField);
      if (typeof rawPath === "string") await assertAllowedWorkspacePath(workspaceRoot, permittedRoots, rawPath, allowMissing);
      return await execute(toolCallId, params, signal, onUpdate, context);
    },
  } as ToolDefinition<any, any, any>;
}

function valueAt(value: unknown, field: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function exactWriterPaths(policy: WorkspaceToolPolicy, writePaths: readonly string[] | undefined): Set<string> {
  if (!writePaths?.length) throw new Error("Workflow configuration error: writers require at least one assigned Wiki page");
  const allowed = new Set<string>();
  for (const rawPath of writePaths) {
    if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid writer page path");
    const absolute = insideWorkspace(policy.workspaceRoot, rawPath);
    const relative = path.relative(policy.wikiRoot, absolute);
    if (!rawPath.startsWith("wiki/") || !relative || path.basename(relative) === "index.md" || !relative.endsWith(".md")
      || relative.split(path.sep).some((part) => part === "." || part === ".." || !part)) {
      throw new Error(`Workflow configuration error: writer path must be a non-index Markdown page under wiki/: ${rawPath}`);
    }
    allowed.add(path.resolve(absolute));
  }
  return allowed;
}

function writerDirectories(wikiRoot: string, allowedPaths: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>([path.resolve(wikiRoot)]);
  for (const file of allowedPaths) {
    let directory = path.dirname(file);
    while (pathIsInside(path.resolve(wikiRoot), directory)) {
      directories.add(directory);
      if (directory === path.resolve(wikiRoot)) break;
      directory = path.dirname(directory);
    }
  }
  return directories;
}

function assertExactWriterPath(allowedPaths: ReadonlySet<string>, candidate: string): void {
  if (!allowedPaths.has(path.resolve(candidate))) {
    throw new Error(`Path is not assigned to this Wiki page writer: ${candidate}`);
  }
}

async function guardedMkdir(root: string, directory: string, allowedDirectories: ReadonlySet<string>): Promise<void> {
  await ensureWikiRoot(root);
  if (!allowedDirectories.has(path.resolve(directory))) throw new Error(`Directory is not assigned to this Wiki page writer: ${directory}`);
  await assertContainedAbsolutePath(root, directory, true);
  await mkdir(directory, { recursive: true });
}

async function guardedWrite(root: string, file: string, content: string, allowedPaths: ReadonlySet<string>): Promise<void> {
  await ensureWikiRoot(root);
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, true);
  await writeFile(file, content, "utf8");
}

async function guardedRead(root: string, file: string, allowedPaths: ReadonlySet<string>): Promise<Buffer> {
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, false);
  return await readFile(file);
}

async function guardedAccess(root: string, file: string, allowedPaths: ReadonlySet<string>): Promise<void> {
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, false);
  await access(file);
}

async function assertAllowedWorkspacePath(
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

function insideWorkspace(root: string, candidate: string): string {
  const absolute = path.resolve(root, candidate);
  if (!pathIsInside(path.resolve(root), absolute)) throw new Error(`Path is outside the workspace: ${candidate}`);
  return absolute;
}

function pathIsInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(location: string): Promise<boolean> {
  try {
    await lstat(location);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function assertContainedAbsolutePath(root: string, candidate: string, allowMissing: boolean, rootLabel = "Wiki root"): Promise<string> {
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

async function ensureWikiRoot(root: string): Promise<void> {
  const requested = path.resolve(root);
  await mkdir(requested, { recursive: true });
  const physical = await realpath(requested);
  assertPathPrefix(requested, physical);
}

function assertPathPrefix(root: string, target: string, rootLabel = "Wiki root"): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Path escapes the ${rootLabel}: ${target}`);
}
