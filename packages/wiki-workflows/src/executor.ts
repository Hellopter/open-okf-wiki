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
  artifactSubmissionSchema,
  MAX_CONTROL_ARTIFACT_BYTES,
  parseArtifactSubmission,
  parseResearchArtifact,
  parseReviewArtifact,
  parseSynthesisArtifact,
  MAX_RESEARCH_ARTIFACT_BYTES,
  WikiControlSubmissionSizeError,
} from "./control-submissions.js";
import type {
  WikiAgentExecutionRequest,
  WikiAgentExecutionResult,
  WikiAgentExecutor,
  WikiControlSubmission,
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

type SubmissionToolName = "wiki_submit_research" | "wiki_submit_synthesis" | "wiki_submit_page" | "wiki_submit_review";

interface SubmissionCollector {
  toolName: SubmissionToolName;
  artifactPath?: string;
  pagePath?: string;
  value?: unknown;
  failure?: SubmissionFailure;
  validate?: (submission: WikiControlSubmission) => void;
  validatePage?: WikiAgentExecutionRequest["validatePageSubmission"];
}

type SubmissionFailureCode = "invalid_submission" | "submission_too_large" | "validator_infrastructure";

interface SubmissionFailure {
  code: SubmissionFailureCode;
  message: string;
}

/** A node ended without the tool submission required to advance the Wiki DAG. */
export class WikiAgentProtocolError extends Error {
  readonly code: "missing_submission" | SubmissionFailureCode;

  constructor(
    readonly requiredSubmissionTool: SubmissionToolName,
    readonly output: string,
    readonly history: WikiNodeHistoryEntry[],
    failure?: SubmissionFailure,
  ) {
    super(failure
      ? `Agent could not complete ${requiredSubmissionTool}: ${failure.message}`
      : `Agent did not call ${requiredSubmissionTool} before completing`);
    this.code = failure?.code ?? "missing_submission";
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
    const submission = submissionFor(request);
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
        if (submission.failure?.code === "validator_infrastructure") {
          throw new WikiAgentProtocolError(submission.toolName, output, retainedHistory(history), submission.failure);
        }
        request.onActivity?.({ state: "waiting", message: `Waiting for ${submission.toolName}` });
        const correction = submission.failure ? ` The prior submission was rejected: ${submission.failure.message}` : "";
        const correctionAction = submission.toolName === "wiki_submit_page"
          ? "Fix every reported issue in the assigned page before resubmitting."
          : "Rewrite the complete handoff artifact before resubmitting; do not reply with JSON text.";
        await session.followUp(`Before completing this node, submit a valid final result with ${submission.toolName}.${correction} ${submissionContractGuidance(submission.toolName)} ${correctionAction} After it is recorded, stop.`);
        await session.waitForIdle();
        if (request.signal.aborted) throw new Error("Workflow node was cancelled");
        output = session.getLastAssistantText() ?? "";
        request.onOutput?.(output);
        if (session.state.errorMessage) throw new Error(session.state.errorMessage);
        if (submission.value === undefined) {
          throw new WikiAgentProtocolError(submission.toolName, output, retainedHistory(history), submission.failure);
        }
      }
      const stats = session.getSessionStats();
      const context = session.getContextUsage();
      request.onActivity?.({ state: "completed", message: "Completed" }, metricsFromSession(session));
      return {
        result: submission?.value,
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
    if (request.role === "researcher" && !request.readRoots?.length) {
      throw new Error("Workflow configuration error: researcher requests require at least one source root");
    }
    if (request.role !== "writer" && !request.artifactWritePath) {
      throw new Error(`Workflow configuration error: ${request.role} requests require an artifact write path`);
    }
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

    const customTools = workflowTools(
      toolPolicy,
      request.role,
      submission,
      request.writePaths,
      request.readRoots,
      request.artifactPaths,
      request.wikiReadPaths,
      request.artifactWritePath,
    );
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
  sourceRoots: Map<string, PermittedToolRoot>;
  wikiRoot: string;
  artifactRoot: string;
}

interface PermittedToolRoot {
  logicalRoot: string;
  physicalRoot?: string;
}

async function workspaceToolPolicy(cwd: string): Promise<WorkspaceToolPolicy> {
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

function workflowTools(
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
    guardWorkspaceTool(createReadToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"),
    guardWorkspaceTool(createGrepToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"),
    guardWorkspaceTool(createFindToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"),
    guardWorkspaceTool(createLsToolDefinition(policy.workspaceRoot), policy.workspaceRoot, readableRoots, "path"),
  ];
  const artifactWriter = artifactWritePath ? createArtifactWriteToolDefinition(policy, artifactWritePath, submission?.toolName) : undefined;
  if (role !== "writer") return [
    ...readOnly,
    ...(artifactWriter ? [artifactWriter] : []),
    ...(submission ? [submissionTool(policy, submission)] : []),
  ];

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
    ...(submission ? [submissionTool(policy, submission)] : []),
  ];
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

function submissionFor(request: WikiAgentExecutionRequest): SubmissionCollector | undefined {
  if (request.node.kind === "write") {
    if (!request.validatePageSubmission || request.writePaths?.length !== 1) {
      throw new Error("Workflow configuration error: writers require one page submission validator");
    }
    const pagePath = request.writePaths[0].replace(/^wiki\//, "");
    return { toolName: "wiki_submit_page", pagePath, validatePage: request.validatePageSubmission };
  }
  if (request.node.kind !== "research" && request.node.kind !== "synthesis" && request.node.kind !== "review") return undefined;
  if (!request.artifactWritePath) throw new Error(`Workflow configuration error: ${request.node.kind} requires an artifact write path`);
  if (request.node.kind === "research") {
    return { toolName: "wiki_submit_research", artifactPath: request.artifactWritePath };
  }
  if (request.node.kind === "synthesis") {
    return { toolName: "wiki_submit_synthesis", artifactPath: request.artifactWritePath, validate: request.validateControlSubmission };
  }
  if (request.node.kind === "review") {
    return { toolName: "wiki_submit_review", artifactPath: request.artifactWritePath, validate: request.validateControlSubmission };
  }
  return undefined;
}

function submissionTool(policy: WorkspaceToolPolicy, submission: SubmissionCollector): ToolDefinition<any, any, any> {
  if (submission.toolName === "wiki_submit_page") {
    const pagePath = submission.pagePath!;
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: `Validate and submit the assigned Wiki page ${pagePath}. Fix every reported issue and resubmit until accepted.`,
      promptSnippet: "Validate and submit the assigned Wiki page",
      promptGuidelines: ["After writing the page, call this tool. If it reports issues, fix all of them and call it again. Stop only after the page is accepted."],
      parameters: Type.Object({ page: Type.Literal(pagePath) }, { additionalProperties: false }),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params: { page: string }) {
        await recordSubmission(submission, async () => {
          if (params.page !== pagePath || !submission.validatePage) throw new Error("Page submission does not match the assigned page");
          let result;
          try {
            result = await submission.validatePage(pagePath);
          } catch (error) {
            throw new WikiPageValidatorInfrastructureError(error);
          }
          if (!result.ok) throw new Error(result.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"));
          return result.submission;
        });
        return { content: [{ type: "text", text: `Wiki page accepted: ${pagePath}` }], details: undefined, terminate: true };
      },
    };
  }
  if (submission.toolName === "wiki_submit_research") {
    const artifactPath = submission.artifactPath!;
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: `Submit the structured research result from ${artifactPath}. ${submissionContractGuidance(submission.toolName)}`,
      promptSnippet: "Submit the structured Wiki research result",
      promptGuidelines: [`Write the complete JSON handoff artifact, then submit its exact path. ${submissionContractGuidance(submission.toolName)} Correct and resubmit if rejected; after it is recorded, stop.`],
      parameters: artifactSubmissionSchema(artifactPath),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params) {
        await recordSubmission(submission, async () => {
          const submittedPath = parseArtifactSubmission(params, artifactPath);
          return parseResearchArtifact(await readArtifactText(policy, submittedPath));
        });
        return { content: [{ type: "text", text: "Wiki research recorded." }], details: undefined, terminate: true };
      },
    };
  }
  if (submission.toolName === "wiki_submit_synthesis") {
    const artifactPath = submission.artifactPath!;
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: `Submit the synthesis result by referencing the exact JSON handoff artifact written for this node. ${submissionContractGuidance(submission.toolName)}`,
      promptSnippet: "Submit the Wiki synthesis decision",
      promptGuidelines: [`Write the complete JSON handoff artifact, then submit its exact path. ${submissionContractGuidance(submission.toolName)} Correct and resubmit if rejected; after it is recorded, stop.`],
      parameters: artifactSubmissionSchema(artifactPath),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params) {
        await recordSubmission(submission, async () => {
          const submittedPath = parseArtifactSubmission(params, artifactPath);
          const parsed = parseSynthesisArtifact(await readArtifactText(policy, submittedPath));
          submission.validate?.(parsed);
          return parsed;
        });
        return { content: [{ type: "text", text: "Wiki synthesis recorded." }], details: undefined, terminate: true };
      },
    };
  }
  return {
    name: submission.toolName,
    label: submission.toolName,
    description: `Submit the review result by referencing the exact JSON handoff artifact written for this node. ${submissionContractGuidance(submission.toolName)}`,
    promptSnippet: "Submit the final Wiki review",
    promptGuidelines: [`Write the complete JSON handoff artifact, then submit its exact path. ${submissionContractGuidance(submission.toolName)} Correct and resubmit if rejected; after it is recorded, stop.`],
    parameters: artifactSubmissionSchema(submission.artifactPath!),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params) {
      await recordSubmission(submission, async () => {
        const artifactPath = parseArtifactSubmission(params, submission.artifactPath!);
        const parsed = parseReviewArtifact(await readArtifactText(policy, artifactPath));
        submission.validate?.(parsed);
        return parsed;
      });
      return { content: [{ type: "text", text: "Wiki review recorded." }], details: undefined, terminate: true };
    },
  };
}

async function recordSubmission(submission: SubmissionCollector, parse: () => unknown | Promise<unknown>): Promise<void> {
  try {
    if (submission.value !== undefined) throw new Error(`${submission.toolName} may only be called once per node attempt`);
    submission.value = structuredClone(await parse());
    submission.failure = undefined;
  } catch (error) {
    submission.failure = {
      code: error instanceof WikiControlSubmissionSizeError ? "submission_too_large"
        : error instanceof WikiPageValidatorInfrastructureError ? "validator_infrastructure"
          : "invalid_submission",
      message: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

class WikiPageValidatorInfrastructureError extends Error {
  constructor(cause: unknown) {
    super(`Page validator infrastructure failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const artifactWriteSchema = Type.Object({
  content: Type.String({ description: "Complete Markdown or JSON handoff content for this node's assigned artifact" }),
}, { additionalProperties: false });

/** Write only the engine-assigned handoff file; the model never chooses its path. */
function createArtifactWriteToolDefinition(
  policy: WorkspaceToolPolicy,
  artifactPath: string,
  submissionToolName?: SubmissionToolName,
): ToolDefinition<typeof artifactWriteSchema> {
  const expectedPath = resolveArtifactPath(policy, artifactPath);
  const contract = submissionToolName ? submissionContractGuidance(submissionToolName) : undefined;
  return {
    name: "wiki_write_handoff",
    label: "wiki_write_handoff",
    description: `Write the complete handoff artifact at ${expectedPath}. This is the only handoff path available to this node.${contract ? ` ${contract}` : ""}`,
    promptSnippet: "Write the node handoff artifact",
    promptGuidelines: [`Write the complete artifact once it is ready. Do not write handoff data to any other path.${contract ? ` ${contract}` : ""}`],
    parameters: artifactWriteSchema,
    async execute(_toolCallId, params) {
      if (typeof params.content !== "string") throw new Error("Handoff artifact content must be text");
      await writeArtifactText(policy, expectedPath, params.content);
      return { content: [{ type: "text", text: `Handoff artifact recorded at ${expectedPath}.` }], details: undefined };
    },
  };
}

/** Keep every model-facing control surface explicit about its JSON contract. */
function submissionContractGuidance(toolName: SubmissionToolName): string {
  if (toolName === "wiki_submit_research") {
    return "Use {\"summary\":\"...\",\"findings\":[{\"kind\":\"domain|concept|flow|boundary|state-data\",\"title\":\"...\",\"readerQuestion\":\"...\",\"priority\":\"critical|normal\",\"evidence\":[\"project/path#L1-L2\"]}],\"gaps\":[{\"question\":\"...\",\"priority\":\"critical|normal\",\"sourcePaths\":[\"project\"]}]}";
  }
  if (toolName === "wiki_submit_page") {
    return "Call the tool with the exact assigned page path after writing. Fix every returned issue and resubmit until accepted.";
  }
  if (toolName === "wiki_submit_synthesis") {
    return "For a final decision, use {\"decision\":\"finalize\",\"spec\":{\"domains\":[...],\"crossLinks\":[...],\"sharedTerms\":[...],\"omissions\":[...]},\"rationale\":\"...\"}. Each page contains pageType, path, title, purpose, and findingIds. For expansion, omit spec and use {\"decision\":\"expand\",\"researchScopes\":[{\"id\":\"new-scope-id\",\"sourcePaths\":[\"declared-source\"],\"task\":\"...\"}],\"rationale\":\"...\"}.";
  }
  return "Use {\"defects\":[...],\"summary\":\"...\"}. A local defect is exactly {\"kind\":\"evidence|link|depth|diagram\",\"page\":\"...\",\"detail\":\"...\"}; a structural defect is exactly {\"kind\":\"topology|coverage\",\"detail\":\"...\"}. defects and summary are required; use [] when there are no actionable defects.";
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

function resolveArtifactPath(policy: WorkspaceToolPolicy, rawPath: string): string {
  if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid artifact path");
  const artifactPath = insideWorkspace(policy.workspaceRoot, rawPath);
  const artifactRoot = path.resolve(policy.artifactRoot);
  if (artifactPath === artifactRoot || !pathIsInside(artifactRoot, artifactPath) || ![".json", ".md"].includes(path.extname(artifactPath))) {
    throw new Error(`Workflow configuration error: artifact path must be a Markdown or JSON file under .okf-wiki/runs: ${rawPath}`);
  }
  return path.resolve(artifactPath);
}

async function readArtifactText(policy: WorkspaceToolPolicy, artifactPath: string): Promise<string> {
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

async function writeArtifactText(policy: WorkspaceToolPolicy, artifactPath: string, content: string): Promise<void> {
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
