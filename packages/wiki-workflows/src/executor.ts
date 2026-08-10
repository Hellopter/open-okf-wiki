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
import {
  parsePlanSubmission,
  parseReviewSubmission,
  planSubmissionSchema,
  reviewSubmissionSchema,
} from "./control-submissions.js";
import type {
  WikiAgentExecutionRequest,
  WikiAgentExecutionResult,
  WikiAgentExecutor,
  WikiNodeHistoryEntry,
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

type SubmissionToolName = "wiki_submit_plan" | "wiki_submit_review";

interface SubmissionCollector {
  toolName: SubmissionToolName;
  value?: unknown;
}

/** A node ended without the tool submission required to advance the Wiki DAG. */
export class WikiAgentProtocolError extends Error {
  readonly code = "missing_submission";

  constructor(
    readonly requiredSubmissionTool: SubmissionToolName,
    readonly output: string,
    readonly history: WikiNodeHistoryEntry[],
  ) {
    super(`Agent did not call ${requiredSubmissionTool} before completing`);
  }
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
    const submission = submissionFor(request.node.kind);
    const session = await this.createIsolatedSession(request, submission);
    session.setAutoCompactionEnabled(true);
    session.setAutoRetryEnabled(true);
    const history: WikiNodeHistoryEntry[] = [];
    const toolTargets = new Map<string, { target?: string; summary?: string }>();
    const unsubscribe = session.subscribe((event) => this.handleEvent(session, event, request, history, toolTargets));
    const abort = () => { void session.abort(); };
    request.signal.addEventListener("abort", abort, { once: true });

    try {
      request.onActivity?.({ state: "running", message: "Running" });
      await session.prompt(request.prompt);
      await session.waitForIdle();
      if (request.signal.aborted) throw new Error("Workflow node was cancelled");
      let output = session.getLastAssistantText() ?? "";
      request.onOutput?.(output);
      if (session.state.errorMessage) throw new Error(session.state.errorMessage);

      if (submission && submission.value === undefined) {
        request.onActivity?.({ state: "waiting", message: `Waiting for ${submission.toolName}` });
        await session.followUp(`Before completing this node, call ${submission.toolName} exactly once with the final result. Do not reply with JSON text.`);
        await session.waitForIdle();
        if (request.signal.aborted) throw new Error("Workflow node was cancelled");
        output = session.getLastAssistantText() ?? "";
        request.onOutput?.(output);
        if (session.state.errorMessage) throw new Error(session.state.errorMessage);
        if (submission.value === undefined) {
          throw new WikiAgentProtocolError(submission.toolName, output, retainedHistory(history));
        }
      }
      const stats = session.getSessionStats();
      const context = session.getContextUsage();
      request.onActivity?.({ state: "completed", message: "Completed" }, metricsFromSession(session));
      return {
        result: submission?.value ?? (request.node.kind === "research" ? output : undefined),
        output,
        history: retainedHistory(history),
        metrics: metricsFromStats(stats, context, session),
      };
    } finally {
      request.signal.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  }

  private async createIsolatedSession(request: WikiAgentExecutionRequest, submission?: SubmissionCollector): Promise<AgentSession> {
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

    const customTools = workflowTools(toolPolicy, request.role, submission);
    const result = await (this.options.createSession ?? createAgentSession)({
      cwd: toolPolicy.workspaceRoot,
      model: this.options.getModel?.() ?? this.options.model,
      thinkingLevel: this.options.getThinkingLevel?.() ?? this.options.thinkingLevel,
      sessionManager: SessionManager.inMemory(toolPolicy.workspaceRoot),
      settingsManager,
      resourceLoader,
      // These guarded definitions are the complete child-agent tool surface.
      // Deriving the allowlist from them prevents a custom tool being registered
      // yet silently hidden from the model.
      noTools: "builtin",
      tools: customTools.map((tool) => tool.name),
      customTools,
    });
    if (submission && !result.session.getActiveToolNames().includes(submission.toolName)) {
      result.session.dispose();
      throw new Error(`Workflow configuration error: ${submission.toolName} is not active for ${request.node.kind}`);
    }
    return result.session;
  }

  private handleEvent(
    session: AgentSession,
    event: AgentSessionEvent,
    request: WikiAgentExecutionRequest,
    history: WikiNodeHistoryEntry[],
    toolTargets: Map<string, { target?: string; summary?: string }>,
  ): void {
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
      case "message_end": {
        const text = assistantText(event.message);
        if (text) appendHistory(history, request, { at: new Date().toISOString(), kind: "message", text });
        const messageError = assistantError(event.message);
        if (messageError) appendHistory(history, request, { at: new Date().toISOString(), kind: "error", text: messageError, isError: true });
        return;
      }
      case "tool_execution_start":
        {
          const target = toolTarget(event.args);
          const summary = toolCallSummary(event.toolName, event.args);
          toolTargets.set(event.toolCallId, { target, summary });
        appendHistory(history, request, {
          at: new Date().toISOString(),
          kind: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          target,
          summary,
          text: compactJson(event.args),
        });
        }
        request.onActivity?.({ state: "running", message: `Using ${event.toolName}` });
        return;
      case "tool_execution_end":
        {
          const source = toolTargets.get(event.toolCallId);
          const text = toolResultText(event.result);
        appendHistory(history, request, {
          at: new Date().toISOString(),
          kind: event.isError ? "error" : "tool_result",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          target: source?.target,
          summary: event.isError ? firstLine(text) : toolResultSummary(event.toolName, text, source?.summary),
          text,
          isError: event.isError,
        });
        toolTargets.delete(event.toolCallId);
        }
        return;
      default:
        return;
    }
  }
}

const MAX_HISTORY_ENTRIES = 48;
const MAX_HISTORY_ENTRY_CHARS = 2_000;
const MAX_HISTORY_CHARS = 24 * 1024;

function appendHistory(
  history: WikiNodeHistoryEntry[],
  request: WikiAgentExecutionRequest,
  entry: WikiNodeHistoryEntry,
): void {
  history.push({ ...entry, text: retainedText(entry.text, MAX_HISTORY_ENTRY_CHARS) });
  const retained = retainedHistory(history);
  history.splice(0, history.length, ...retained);
  request.onHistory?.(retained);
}

function retainedHistory(history: WikiNodeHistoryEntry[]): WikiNodeHistoryEntry[] {
  const retained: WikiNodeHistoryEntry[] = [];
  let chars = 0;
  for (const entry of history.slice(-MAX_HISTORY_ENTRIES).reverse()) {
    const remaining = MAX_HISTORY_CHARS - chars;
    if (remaining <= 0) break;
    const text = retainedText(entry.text, remaining);
    retained.unshift({ ...entry, text });
    chars += text.length;
  }
  return retained;
}

function retainedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 40) return text.slice(-limit);
  let retainedLength = limit;
  let marker = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    marker = `[... ${text.length - retainedLength} earlier characters omitted ...]\n`;
    const nextLength = Math.max(0, limit - marker.length);
    if (nextLength === retainedLength) break;
    retainedLength = nextLength;
  }
  return `${marker}${text.slice(-retainedLength)}`;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function toolResultText(value: unknown): string {
  if (!value || typeof value !== "object") return compactJson(value);
  const result = value as { content?: unknown };
  if (!Array.isArray(result.content)) return compactJson(value);
  const text = result.content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "")
    .filter(Boolean)
    .join("\n");
  return text || compactJson(value);
}

function toolTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "file", "directory"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}

function toolCallSummary(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  if ((toolName === "grep" || toolName === "find") && typeof record.pattern === "string") return record.pattern;
  return undefined;
}

function toolResultSummary(toolName: string, text: string, callSummary?: string): string {
  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    const count = text.split("\n").filter(Boolean).length;
    return count ? `${count} result${count === 1 ? "" : "s"}` : "No results";
  }
  return callSummary ?? "Completed";
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
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

function assistantError(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; errorMessage?: unknown };
  return value.role === "assistant" && typeof value.errorMessage === "string" && value.errorMessage.trim()
    ? value.errorMessage
    : undefined;
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

function workflowTools(
  policy: WorkspaceToolPolicy,
  role: WikiAgentExecutionRequest["role"],
  submission?: SubmissionCollector,
): ToolDefinition<any, any, any>[] {
  const readOnly = [
    guardWorkspaceTool(createReadToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
    guardWorkspaceTool(createGrepToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
    guardWorkspaceTool(createFindToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
    guardWorkspaceTool(createLsToolDefinition(policy.workspaceRoot), policy.workspaceRoot, policy.readableRoots, "path"),
  ];
  if (role !== "writer") return submission ? [...readOnly, submissionTool(submission)] : readOnly;

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

function submissionFor(kind: WikiAgentExecutionRequest["node"]["kind"]): SubmissionCollector | undefined {
  if (kind === "plan" || kind === "replan") return { toolName: "wiki_submit_plan" };
  if (kind === "review") return { toolName: "wiki_submit_review" };
  return undefined;
}

function submissionTool(submission: SubmissionCollector): ToolDefinition<any, any, any> {
  if (submission.toolName === "wiki_submit_plan") {
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: "Submit the final Wiki page plan exactly once after source inspection is complete.",
      promptSnippet: "Submit the final Wiki plan",
      promptGuidelines: ["Call wiki_submit_plan exactly once when the final page plan is ready."],
      parameters: planSubmissionSchema,
      async execute(_toolCallId, params) {
        recordSubmission(submission, parsePlanSubmission(params));
        return { content: [{ type: "text", text: "Wiki plan recorded." }], details: undefined };
      },
    };
  }
  return {
    name: submission.toolName,
    label: submission.toolName,
    description: "Submit the final Wiki review exactly once after inspecting the Wiki and source evidence.",
    promptSnippet: "Submit the final Wiki review",
    promptGuidelines: ["Call wiki_submit_review exactly once when the review is complete."],
    parameters: reviewSubmissionSchema,
    async execute(_toolCallId, params) {
      recordSubmission(submission, parseReviewSubmission(params));
      return { content: [{ type: "text", text: "Wiki review recorded." }], details: undefined };
    },
  };
}

function recordSubmission(submission: SubmissionCollector, value: unknown): void {
  if (submission.value !== undefined) throw new Error(`${submission.toolName} may only be called once per node attempt`);
  submission.value = structuredClone(value);
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
