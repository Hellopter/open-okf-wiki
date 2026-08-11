import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
  createArtifactWriteToolDefinition,
  submissionTool,
  type SubmissionCollector,
} from "./agent-submissions.js";
import {
  assertAllowedWorkspacePath,
  assertContainedAbsolutePath,
  ensureWikiRoot,
  insideWorkspace,
  pathIsInside,
  type PermittedToolRoot,
  type WorkspaceToolPolicy,
  workspaceToolPolicy,
  resolveArtifactPath,
  readArtifactText,
  writeArtifactText,
} from "./path-policy.js";
import { boundToolExecutionResult } from "./tool-budget.js";
import type { WikiAgentExecutionRequest } from "./workflow-types.js";

export type { WorkspaceToolPolicy, PermittedToolRoot };
export { workspaceToolPolicy, resolveArtifactPath, readArtifactText, writeArtifactText };

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
