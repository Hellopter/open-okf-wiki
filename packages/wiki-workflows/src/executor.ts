import { access, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import type {
  WikiAgentExecutionRequest,
  WikiAgentExecutionResult,
  WikiAgentExecutor,
  WikiNodeMetrics,
} from "./workflow-types.js";
import { loadWikiWorkspace } from "./workspace.js";

export interface PiAgentExecutorOptions {
  /** The selected Pi model supplied by the extension context, when available. */
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /** Resolve Pi's current selection immediately before each child session starts. */
  getModel?: () => Model<any> | undefined;
  getThinkingLevel?: () => ThinkingLevel | undefined;
  /** Test seam for the Pi SDK session factory. */
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
}

/**
 * Pi-native child-agent executor. Each workflow node receives a fresh in-memory
 * AgentSession so its transcript can compact and retry without contaminating a
 * sibling node. Only bounded node summaries are retained by the workflow run.
 */
export class PiAgentExecutor implements WikiAgentExecutor {
  private readonly options: PiAgentExecutorOptions;

  constructor(options: PiAgentExecutorOptions = {}) {
    this.options = options;
  }

  async execute(request: WikiAgentExecutionRequest): Promise<WikiAgentExecutionResult> {
    const session = await this.createIsolatedSession(request);
    session.setAutoCompactionEnabled(true);
    session.setAutoRetryEnabled(true);
    const unsubscribe = session.subscribe((event) => this.handleEvent(session, event, request));
    const abort = () => { void session.abort(); };
    request.signal.addEventListener("abort", abort, { once: true });

    try {
      request.onActivity?.({ state: "running", message: "Running" });
      await session.prompt(request.prompt);
      await session.waitForIdle();
      if (request.signal.aborted) throw new Error("Workflow node was cancelled");
      if (session.state.errorMessage) throw new Error(session.state.errorMessage);

      let output = session.getLastAssistantText() ?? "";
      let parsed = parseStructuredOutput(output);
      const firstValidationError = request.validateResult?.(parsed);
      if (firstValidationError) {
        request.onActivity?.({ state: "waiting", message: "Repairing structured response" });
        await session.followUp(`Your preceding response was not valid for this task: ${firstValidationError}. Return one corrected JSON object only, with no Markdown fence or explanation.`);
        await session.waitForIdle();
        if (request.signal.aborted) throw new Error("Workflow node was cancelled");
        if (session.state.errorMessage) throw new Error(session.state.errorMessage);
        output = session.getLastAssistantText() ?? "";
        parsed = parseStructuredOutput(output);
        const repairError = request.validateResult?.(parsed);
        if (repairError) throw new Error(`Structured output remained invalid after repair: ${repairError}`);
      }
      const stats = session.getSessionStats();
      const context = session.getContextUsage();
      request.onActivity?.({ state: "completed", message: "Completed" }, metricsFromSession(session));
      return { result: parsed, output, metrics: metricsFromStats(stats, context, session) };
    } finally {
      request.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  }

  private async createIsolatedSession(request: WikiAgentExecutionRequest): Promise<AgentSession> {
    const toolPolicy = await workspaceToolPolicy(request.cwd);
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(toolPolicy.workspaceRoot, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: toolPolicy.workspaceRoot,
      agentDir,
      settingsManager,
      // Workflow children never load the host extension, skills, or prompts.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
    });
    await resourceLoader.reload();

    const result = await (this.options.createSession ?? createAgentSession)({
      cwd: toolPolicy.workspaceRoot,
      model: this.options.getModel?.() ?? this.options.model,
      thinkingLevel: this.options.getThinkingLevel?.() ?? this.options.thinkingLevel,
      sessionManager: SessionManager.inMemory(toolPolicy.workspaceRoot),
      settingsManager,
      resourceLoader,
      // "builtin" preserves custom definitions. `tools` is also an allowlist,
      // so neither bash nor an unguarded built-in edit/write can be activated.
      noTools: "builtin",
      tools: request.role === "writer"
        ? ["read", "grep", "find", "ls", "edit", "write", "wiki_delete"]
        : ["read", "grep", "find", "ls"],
      customTools: workflowTools(toolPolicy, request.role),
    });
    return result.session;
  }

  private handleEvent(session: AgentSession, event: AgentSessionEvent, request: WikiAgentExecutionRequest): void {
    switch (event.type) {
      case "compaction_start":
        request.onActivity?.({ state: "compacting", message: `Compacting (${event.reason})` }, { compactions: 1 });
        return;
      case "compaction_end":
        request.onActivity?.({
          state: event.aborted ? "waiting" : "running",
          message: event.errorMessage ?? (event.aborted ? "Compaction interrupted" : "Compaction completed"),
        });
        return;
      case "auto_retry_start":
        request.onActivity?.({
          state: "retrying",
          message: event.errorMessage,
          retryAttempt: event.attempt,
          retryMaxAttempts: event.maxAttempts,
          retryDelayMs: event.delayMs,
        }, { autoRetries: 1 });
        return;
      case "auto_retry_end":
        request.onActivity?.({ state: event.success ? "running" : "waiting", message: event.finalError });
        return;
      case "summarization_retry_scheduled":
        request.onActivity?.({
          state: "retrying",
          message: `Retrying summary: ${event.errorMessage}`,
          retryAttempt: event.attempt,
          retryMaxAttempts: event.maxAttempts,
          retryDelayMs: event.delayMs,
        }, { autoRetries: 1 });
        return;
      case "summarization_retry_attempt_start":
        request.onActivity?.({ state: "retrying", message: `Retrying ${event.source} summary` });
        return;
      case "summarization_retry_finished":
        request.onActivity?.({ state: "running", message: "Summary retry completed" });
        return;
      case "message_update":
        {
          const output = assistantText(event.message);
          if (output) request.onOutput?.(output);
        }
        request.onActivity?.({ state: "running", message: "Streaming response" }, metricsFromSession(session));
        return;
      case "tool_execution_start":
        request.onActivity?.({ state: "running", message: `Using ${event.toolName}` });
        return;
      default:
        return;
    }
  }
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object"
      && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

export function createPiAgentExecutor(options: PiAgentExecutorOptions = {}): PiAgentExecutor {
  return new PiAgentExecutor(options);
}

interface WorkspaceToolPolicy {
  workspaceRoot: string;
  readableRoots: PermittedToolRoot[];
  wikiRoot: string;
}

interface PermittedToolRoot {
  logicalRoot: string;
  physicalRoot?: string;
}

async function workspaceToolPolicy(cwd: string): Promise<WorkspaceToolPolicy> {
  const workspace = await loadWikiWorkspace(cwd);
  return {
    workspaceRoot: workspace.root,
    readableRoots: [
      { logicalRoot: workspace.root, physicalRoot: await realpath(workspace.root) },
      ...workspace.sources.map((source) => ({ logicalRoot: source.absolutePath, physicalRoot: source.realPath })),
    ],
    wikiRoot: path.join(workspace.root, "wiki"),
  };
}

function workflowTools(policy: WorkspaceToolPolicy, role: WikiAgentExecutionRequest["role"]): ToolDefinition<any, any, any>[] {
  const readOnly = [
    guardWorkspaceTool(createReadToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
    guardWorkspaceTool(createGrepToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
    guardWorkspaceTool(createFindToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
    guardWorkspaceTool(createLsToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
  ];
  if (role !== "writer") return readOnly;

  const write = createWriteToolDefinition(policy.workspaceRoot, {
    operations: {
      mkdir: async (directory) => await guardedMkdir(policy.wikiRoot, directory),
      writeFile: async (file, content) => await guardedWrite(policy.wikiRoot, file, content),
    },
  });
  const edit = createEditToolDefinition(policy.workspaceRoot, {
    operations: {
      access: async (file) => await guardedAccess(policy.wikiRoot, file),
      readFile: async (file) => await guardedRead(policy.wikiRoot, file),
      writeFile: async (file, content) => await guardedWrite(policy.wikiRoot, file, content),
    },
  });
  return [
    ...readOnly,
    // Inputs are resolved by Pi's built-in definitions against the workspace.
    // The guarded operations below receive those absolute paths and enforce wiki/.
    guardWorkspaceTool(edit, policy.workspaceRoot, [{ logicalRoot: policy.wikiRoot }], "path"),
    guardWorkspaceTool(write, policy.workspaceRoot, [{ logicalRoot: policy.wikiRoot }], "path", true),
    createDeleteToolDefinition(policy),
  ];
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

const deleteSchema = Type.Object({
  path: Type.String({ description: "Workspace-relative Wiki page path to remove" }),
});

function createDeleteToolDefinition(policy: WorkspaceToolPolicy): ToolDefinition<typeof deleteSchema> {
  return {
    name: "wiki_delete",
    label: "wiki_delete",
    description: "Delete one obsolete regular file under wiki/. Directories and paths outside wiki/ are rejected.",
    promptSnippet: "Delete obsolete generated Wiki pages",
    promptGuidelines: ["Use wiki_delete only for obsolete files under wiki/"],
    parameters: deleteSchema,
    async execute(_toolCallId, { path: rawPath }) {
      const workspacePath = await assertAllowedWorkspacePath(policy.workspaceRoot, [{ logicalRoot: policy.wikiRoot }], rawPath, false);
      if (path.resolve(workspacePath) === path.resolve(policy.wikiRoot)) throw new Error("Cannot delete the Wiki root");
      const entry = await lstat(workspacePath);
      if (!entry.isFile()) throw new Error("wiki_delete only accepts regular files");
      await rm(workspacePath);
      return { content: [{ type: "text", text: `Deleted ${rawPath}` }], details: undefined };
    },
  };
}

function valueAt(value: unknown, field: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

async function guardedMkdir(root: string, directory: string): Promise<void> {
  await ensureWikiRoot(root);
  await assertContainedAbsolutePath(root, directory, true);
  await mkdir(directory, { recursive: true });
}

async function guardedWrite(root: string, file: string, content: string): Promise<void> {
  await ensureWikiRoot(root);
  await assertContainedAbsolutePath(root, file, true);
  await writeFile(file, content, "utf8");
}

async function guardedRead(root: string, file: string): Promise<Buffer> {
  await assertContainedAbsolutePath(root, file, false);
  return await readFile(file);
}

async function guardedAccess(root: string, file: string): Promise<void> {
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

async function assertContainedAbsolutePath(root: string, candidate: string, allowMissing: boolean): Promise<string> {
  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const absolute = path.resolve(candidate);
  assertPathPrefix(rootReal, absolute);

  let existing = absolute;
  while (true) {
    let real: string;
    try {
      real = await realpath(existing);
    } catch (error) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        throw new Error(`Path escapes the Wiki root: ${candidate}`);
      }
      if (!allowMissing && existing === absolute) throw error;
      existing = parent;
      continue;
    }
    // Do not catch this containment failure as though the entry were missing.
    assertPathPrefix(rootReal, real);
    return absolute;
  }
}

async function ensureWikiRoot(root: string): Promise<void> {
  const requested = path.resolve(root);
  await mkdir(requested, { recursive: true });
  const physical = await realpath(requested);
  assertPathPrefix(requested, physical);
}

function assertPathPrefix(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`Path escapes the Wiki root: ${target}`);
}

function parseStructuredOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return "";
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)?.[1] ?? trimmed;
  try {
    return JSON.parse(fenced);
  } catch {
    return output;
  }
}

function metricsFromSession(session: AgentSession): Partial<WikiNodeMetrics> {
  return metricsFromStats(session.getSessionStats(), session.getContextUsage(), session);
}

function metricsFromStats(
  stats: ReturnType<AgentSession["getSessionStats"]>,
  context: ReturnType<AgentSession["getContextUsage"]>,
  session: AgentSession,
): Partial<WikiNodeMetrics> {
  const tokens = stats.tokens;
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    totalTokens: tokens.total,
    cost: stats.cost,
    model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    contextTokens: context?.tokens ?? undefined,
    contextWindow: context?.contextWindow,
    contextPercent: context?.percent ?? undefined,
    contextEstimated: context?.tokens !== undefined && context.tokens !== null,
  };
}
