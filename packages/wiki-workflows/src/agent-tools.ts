import { access, mkdir, readFile } from "node:fs/promises";
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
  assertAllowedWorkspacePath,
  assertContainedAbsolutePath,
  ensureWikiRoot,
  insideWorkspace,
  pathIsInside,
  type PermittedToolRoot,
  type WorkspaceToolPolicy,
  workspaceToolPolicy,
} from "./path-policy.js";
import { boundToolExecutionResult } from "./tool-budget.js";
import { isSafeWikiPagePath } from "./lead.js";

export type WikiToolRole = "lead" | "researcher" | "writer" | "reviewer";

export type { WorkspaceToolPolicy, PermittedToolRoot };
export { workspaceToolPolicy };

export interface WikiPageWriter {
  replacePage(input: { path: string; content: string; actor: "lead" | "writer" }): Promise<void>;
}

export function workflowTools(
  policy: WorkspaceToolPolicy,
  role: WikiToolRole,
  writePaths: readonly string[] | undefined,
  readRoots: readonly string[] | undefined,
  reviewPaths: readonly string[] | undefined,
  pageWriter: WikiPageWriter | undefined,
  reviewIndexPaths?: readonly string[],
): ToolDefinition<any, any, any>[] {
  const activeWikiRoot = policy.candidateWikiRoot ?? policy.wikiRoot;
  if ((role === "lead" || role === "writer") && !pageWriter) {
    throw new Error(`Workflow configuration error: ${role} requires a transactional WikiPageWriter`);
  }
  const allowedPaths = role === "writer" ? exactWikiPaths(activeWikiRoot, writePaths, "writers") : undefined;
  const reviewerPaths = role === "reviewer" ? exactWikiPaths(activeWikiRoot, reviewPaths, "reviewers") : undefined;
  const reviewerIndexes = role === "reviewer" ? exactIndexPaths(activeWikiRoot, reviewIndexPaths) : undefined;
  const readableRoots = readRootsForPolicy(policy, activeWikiRoot, readRoots, mergePaths(allowedPaths ?? reviewerPaths, reviewerIndexes), role === "lead");
  const readOnly = [
    boundSurveyTool(remapCandidateWikiPath(guardSurveyTool(createReadToolDefinition(policy.workspaceRoot), policy, readableRoots, "read"), policy, activeWikiRoot), "read"),
    boundSurveyTool(remapCandidateWikiPath(guardSurveyTool(createGrepToolDefinition(policy.workspaceRoot), policy, readableRoots, "grep"), policy, activeWikiRoot), "grep"),
    boundSurveyTool(remapCandidateWikiPath(guardSurveyTool(createFindToolDefinition(policy.workspaceRoot), policy, readableRoots, "find"), policy, activeWikiRoot), "find"),
    boundSurveyTool(remapCandidateWikiPath(guardSurveyTool(createLsToolDefinition(policy.workspaceRoot), policy, readableRoots, "ls"), policy, activeWikiRoot), "ls"),
  ];
  if (role === "lead") {
    if (!policy.candidateWikiRoot) throw new Error("Workflow configuration error: Lead requires a candidate Wiki root");
    const candidateRoot = path.resolve(policy.candidateWikiRoot);
    const write = createWriteToolDefinition(policy.workspaceRoot, {
      operations: {
        mkdir: async (directory) => await guardedLeadMkdir(candidateRoot, directory),
        writeFile: async (file, content) => await guardedLeadWrite(candidateRoot, file, content, pageWriter!),
      },
    });
    const edit = createEditToolDefinition(policy.workspaceRoot, {
      operations: {
        access: async (file) => await guardedLeadAccess(candidateRoot, file),
        readFile: async (file) => await guardedLeadRead(candidateRoot, file),
        writeFile: async (file, content) => await guardedLeadWrite(candidateRoot, file, content, pageWriter!),
      },
    });
    return [
      ...readOnly,
      remapCandidateWikiPath(guardWorkspaceTool(edit, policy.workspaceRoot, [{ logicalRoot: candidateRoot }], "path"), policy, candidateRoot),
      remapCandidateWikiPath(guardWorkspaceTool(write, policy.workspaceRoot, [{ logicalRoot: candidateRoot }], "path", true), policy, candidateRoot),
    ];
  }
  if (role !== "writer") return readOnly;

  if (!allowedPaths) throw new Error("Workflow configuration error: writers require assigned Wiki pages");
  const allowedDirectories = writerDirectories(activeWikiRoot, allowedPaths);

  const write = createWriteToolDefinition(policy.workspaceRoot, {
    operations: {
      mkdir: async (directory) => await guardedMkdir(activeWikiRoot, directory, allowedDirectories),
      writeFile: async (file, content) => await guardedWrite(activeWikiRoot, file, content, allowedPaths, pageWriter!),
    },
  });
  const edit = createEditToolDefinition(policy.workspaceRoot, {
    operations: {
      access: async (file) => await guardedAccess(activeWikiRoot, file, allowedPaths),
      readFile: async (file) => await guardedRead(activeWikiRoot, file, allowedPaths),
      writeFile: async (file, content) => await guardedWrite(activeWikiRoot, file, content, allowedPaths, pageWriter!),
    },
  });
  return [
    ...readOnly,
    // Logical wiki/* inputs are transparently redirected to the run candidate.
    // Guarded operations still receive absolute paths and enforce the exact page.
    remapCandidateWikiPath(guardWorkspaceTool(edit, policy.workspaceRoot, [{ logicalRoot: activeWikiRoot }], "path"), policy, activeWikiRoot),
    remapCandidateWikiPath(guardWorkspaceTool(write, policy.workspaceRoot, [{ logicalRoot: activeWikiRoot }], "path", true), policy, activeWikiRoot),
  ];
}

function mergePaths(first?: ReadonlySet<string>, second?: ReadonlySet<string>): ReadonlySet<string> | undefined {
  if (!first && !second) return undefined;
  return new Set([...(first ?? []), ...(second ?? [])]);
}

function exactIndexPaths(activeWikiRoot: string, values: readonly string[] | undefined): Set<string> | undefined {
  if (!values?.length) return undefined;
  const result = new Set<string>();
  for (const rawPath of values) {
    const relative = rawPath.startsWith("wiki/") ? rawPath.slice("wiki/".length) : "";
    if (!relative || path.posix.basename(relative) !== "index.md" || relative.includes("..") || relative.includes("//")) {
      throw new Error(`Workflow configuration error: invalid reviewer index path: ${rawPath}`);
    }
    result.add(path.resolve(activeWikiRoot, ...relative.split("/")));
  }
  return result;
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
  activeWikiRoot: string,
  requested: readonly string[] | undefined,
  writerPaths: ReadonlySet<string> | undefined,
  candidateWide = false,
): PermittedToolRoot[] {
  const assigned: PermittedToolRoot[] = [];
  const declared = [...policy.sourceRoots.keys()];
  for (const sourcePath of requested ?? []) {
    const root = policy.sourceRoots.get(sourcePath);
    if (!root) {
      throw new Error(`Workflow configuration error: undeclared source root: ${sourcePath}. Declared: ${declared.join(", ") || "(none)"}`);
    }
    assigned.push(root);
  }
  for (const writerPath of writerPaths ?? []) assigned.push(exactWorkspaceFileRoot(writerPath));
  if (candidateWide && policy.boardPath) assigned.push(exactWorkspaceFileRoot(policy.boardPath));
  if (assigned.length === 0 && !candidateWide) {
    throw new Error("Workflow configuration error: agent requests require declared source roots or exact artifact paths");
  }
  const roots = [...assigned];
  if (candidateWide) roots.push({ logicalRoot: path.resolve(activeWikiRoot) });
  if (policy.skillRoot) roots.push({ logicalRoot: path.resolve(policy.skillRoot) });
  return roots;
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

/** Survey tools treat omitted path as cwd. Workspace root is not a Source unless a source logicalRoot is that root. */
function guardSurveyTool(
  definition: ToolDefinition<any, any, any>,
  policy: WorkspaceToolPolicy,
  permittedRoots: PermittedToolRoot[],
  toolName: "read" | "grep" | "find" | "ls",
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const rawPath = valueAt(params, "path");
      const surveyPath = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : ".";
      const gatedParams = { ...(params as Record<string, unknown>), path: surveyPath };
      const absolute = insideWorkspace(policy.workspaceRoot, surveyPath);
      const workspaceAbs = path.resolve(policy.workspaceRoot);
      if (toolName === "ls" && absolute === workspaceAbs && !permittedRoots.some((root) => path.resolve(root.logicalRoot) === workspaceAbs)) {
        return listDeclaredSourceDirectories(policy, permittedRoots);
      }
      await assertAllowedWorkspacePath(policy.workspaceRoot, permittedRoots, surveyPath, false);
      return await execute(toolCallId, gatedParams, signal, onUpdate, context);
    },
  } as ToolDefinition<any, any, any>;
}

function listDeclaredSourceDirectories(
  policy: WorkspaceToolPolicy,
  permittedRoots: PermittedToolRoot[],
): { content: Array<{ type: "text"; text: string }> } {
  const permitted = new Set(permittedRoots.map((root) => path.resolve(root.logicalRoot)));
  const names = [...policy.sourceRoots.entries()]
    .filter(([scopeId, root]) => !scopeId.includes("/") && permitted.has(path.resolve(root.logicalRoot)))
    .map(([scopeId]) => scopeId)
    .sort((left, right) => left.localeCompare(right));
  const text = names.length === 0 ? "(empty directory)" : names.map((name) => `${name}/`).join("\n");
  return { content: [{ type: "text", text }] };
}

function valueAt(value: unknown, field: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function exactWikiPaths(
  activeWikiRoot: string,
  writePaths: readonly string[] | undefined,
  role: string,
): Set<string> {
  if (!writePaths?.length) throw new Error(`Workflow configuration error: ${role} require at least one assigned Wiki page`);
  const allowed = new Set<string>();
  for (const rawPath of writePaths) {
    if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid writer page path");
    const relative = rawPath.startsWith("wiki/") ? rawPath.slice("wiki/".length) : undefined;
    if (!isSafeWikiPagePath(relative)) {
      throw new Error(`Workflow configuration error: writer path must be a non-index Markdown page under the active Wiki root: ${rawPath}`);
    }
    allowed.add(path.resolve(activeWikiRoot, ...relative.split("/")));
  }
  return allowed;
}

/** Keep model-facing `wiki/*` paths stable while redirecting I/O to a run candidate. */
function resolveActiveWikiPath(policy: WorkspaceToolPolicy, activeWikiRoot: string, rawPath: string): string {
  if (policy.candidateWikiRoot && (rawPath === "wiki" || rawPath.startsWith("wiki/"))) {
    return path.resolve(activeWikiRoot, rawPath === "wiki" ? "." : rawPath.slice("wiki/".length));
  }
  return insideWorkspace(policy.workspaceRoot, rawPath);
}

function remapCandidateWikiPath(
  definition: ToolDefinition<any, any, any>,
  policy: WorkspaceToolPolicy,
  activeWikiRoot: string,
): ToolDefinition<any, any, any> {
  if (!policy.candidateWikiRoot) return definition;
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const rawPath = valueAt(params, "path");
      const candidatePath = typeof rawPath === "string" && (rawPath === "wiki" || rawPath.startsWith("wiki/"))
        ? resolveActiveWikiPath(policy, activeWikiRoot, rawPath)
        : undefined;
      const mappedParams = candidatePath
        ? { ...(params as Record<string, unknown>), path: candidatePath }
        : params;
      return await execute(toolCallId, mappedParams, signal, onUpdate, context);
    },
  } as ToolDefinition<any, any, any>;
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

async function guardedWrite(root: string, file: string, content: string, allowedPaths: ReadonlySet<string>, writer: WikiPageWriter): Promise<void> {
  await ensureWikiRoot(root);
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, true);
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join("/");
  await writer.replacePage({ path: `wiki/${relative}`, content, actor: "writer" });
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

function assertLeadMarkdownPath(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || !pathIsInside(path.resolve(root), absolute) || !relative.endsWith(".md")
    || relative.split(path.sep).some((part) => part === "." || part === ".." || !part)) {
    throw new Error(`Lead may write only Markdown files under the candidate Wiki: ${candidate}`);
  }
}

async function guardedLeadMkdir(root: string, directory: string): Promise<void> {
  await ensureWikiRoot(root);
  await assertContainedAbsolutePath(root, directory, true);
  await mkdir(directory, { recursive: true });
}

async function guardedLeadWrite(root: string, file: string, content: string, writer: WikiPageWriter): Promise<void> {
  await ensureWikiRoot(root);
  assertLeadMarkdownPath(root, file);
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join("/");
  if (!isSafeWikiPagePath(relative) && path.posix.basename(relative) !== "log.md") {
    throw new Error(`Lead may write only safe concept pages or log.md: ${file}`);
  }
  await assertContainedAbsolutePath(root, file, true);
  await writer.replacePage({ path: `wiki/${relative}`, content, actor: "lead" });
}

async function guardedLeadRead(root: string, file: string): Promise<Buffer> {
  assertLeadMarkdownPath(root, file);
  await assertContainedAbsolutePath(root, file, false);
  return await readFile(file);
}

async function guardedLeadAccess(root: string, file: string): Promise<void> {
  assertLeadMarkdownPath(root, file);
  await assertContainedAbsolutePath(root, file, false);
  await access(file);
}
