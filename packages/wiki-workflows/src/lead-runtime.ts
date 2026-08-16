import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { workflowTools, type WikiPageWriter } from "./agent-tools.js";
import { createWikiArtifactStore } from "./artifact-store.js";
import {
  boundedDelegateSummary,
  WikiTaskExecutionError,
  WikiTaskPauseError,
  type WikiDelegateBatchSnapshot,
  type WikiDelegateContract,
  type WikiDelegateGap,
  type WikiDelegateTask,
} from "./delegate-contracts.js";
import type { WikiAgentTelemetry, WikiContextStats, WikiTaskSnapshot } from "./producer-types.js";
import type { WikiLeadRuntime, WikiPinnedSourcePlan } from "./runtime-types.js";
import type { WikiExecutionBudgets } from "./producer-types.js";
import { PiSessionObserver, readSessionUsage, type PiSessionObserverOptions } from "./pi-session-observer.js";
import { WikiTaskRuntime, WikiWritePathLease, type WikiLeafAgent, type WikiLeafResult, type WikiLeafTaskContext, type WikiTaskProgressEvent } from "./task-runtime.js";
import {
  parseWikiSpec,
  wikiPlanParameters,
  wikiSpecPagePaths,
  wikiSpecPages,
  type WikiSpec,
} from "./wiki-spec.js";
import { derivedIndexPaths } from "./wiki-validate.js";
import type { WikiReviewResult } from "./delegate-contracts.js";
import path from "node:path";
import type { WikiAgentRole, WikiGenerationProfile } from "./workspace.js";
import { WikiBudgetExhaustedError } from "./failures.js";
import { WikiLeadRun } from "./wiki-lead-run.js";
import { decideWikiAgentAttempt } from "./agent-attempt-policy.js";
import { pinnedWorkspaceToolPolicy } from "./path-policy.js";

const PI_SESSION_REQUEST_RETRIES = 0;
const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60_000;
const MAX_SESSION_TIMEOUT_MS = 2_147_483_647;

export interface PiWikiLeadAgentOptions {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  language?: "zh" | "en";
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
  /** Hard deadline for each Lead or delegated Pi session. Default 20 minutes. */
  sessionTimeoutMs?: number;
  /** Materialized production skill root inside the workspace. */
  skillRoot?: string;
  /** Run-scoped persistent Pi session directory. */
  sessionDir?: string;
  /** Exact Pi session file to reopen. */
  sessionFile?: string;
  budgets?: WikiExecutionBudgets;
  /** Single Pi skill exposed to this session. */
  skillName?: string;
  skillPath?: string;
  sourcePlan?: WikiPinnedSourcePlan;
}

export interface CreatePiLeadRuntimeOptions extends PiWikiLeadAgentOptions {
  concurrency?: number;
  transientRetries?: number;
  baseRetryDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  models?: PiWikiRoleModels;
  runSessionDirectory?: string;
  leadSessionFile?: string;
  leadSessionAttempt?: number;
}

export interface PiWikiRoleModel {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

export type PiWikiRoleModels = Record<WikiAgentRole, PiWikiRoleModel>;

/** Complete reusable production Adapter for WikiProducer's model-facing seam. */
export function createPiLeadRuntime(options: CreatePiLeadRuntimeOptions = {}): WikiLeadRuntime {
  const transientRetries = options.transientRetries ?? 1;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  if (!Number.isInteger(transientRetries) || transientRetries < 0) throw new Error("transientRetries must be a non-negative integer");
  if (!Number.isFinite(baseRetryDelayMs) || baseRetryDelayMs < 0) throw new Error("baseRetryDelayMs must be non-negative");
  const sessionTimeoutMs = validatedSessionTimeoutMs(options.sessionTimeoutMs);
  const leadModel = options.models?.lead ?? { model: options.model, thinkingLevel: options.thinkingLevel };
  const sessionOptions = {
    model: leadModel.model,
    thinkingLevel: leadModel.thinkingLevel,
    createSession: options.createSession,
    sessionTimeoutMs,
    language: options.language,
    budgets: options.budgets,
  };
  return {
    async run(request) {
      const leadRun = await WikiLeadRun.open({
        workspace: request.sourcePlan.workspaceRoot,
        runId: request.runId,
        candidateWikiRoot: request.candidateWikiRoot,
        policy: request.generation,
        requiredSections: request.generation.templates.requiredSections,
        sourcePlan: request.sourcePlan,
        language: request.language,
        executionFence: {
          runStateFile: path.join(request.sourcePlan.workspaceRoot, ".okf-wiki", "runs", request.runId, "run-state.json"),
          attempt: request.attempt,
          executionToken: request.executionToken,
        },
      });
      let specRecord = leadRun.specRecord;
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) controller.abort(request.signal.reason);
      const writeLease = new WikiWritePathLease();
      const generation = request.generation;
      const requiredReviewCoverage = generation.review.mustCover;
      const pageWriter: WikiPageWriter = {
        async replacePage(input) {
          const release = input.actor === "lead" ? await writeLease.acquire([input.path], controller.signal) : undefined;
          try { await leadRun.replacePage(input); }
          finally { release?.(); }
        },
      };
      const artifactStore = createWikiArtifactStore({ workspace: request.sourcePlan.workspaceRoot });
      const sourceScopes = request.sourcePlan.sources.map((source) => source.scopeId);
      const budgets = request.budgets ?? options.budgets;
      const roleModels = options.models;
      const runSessionDirectory = request.runSessionDirectory ?? options.runSessionDirectory ?? options.sessionDir;
      const batchTasks = new Map<number, Map<string, WikiTaskSnapshot>>();
      const snapshotNow = () => new Date((options.now ?? Date.now)()).toISOString();
      const onTask = async (event: WikiTaskProgressEvent): Promise<void> => {
        let projection = batchTasks.get(event.batchId);
        if (!projection) {
          projection = new Map();
          batchTasks.set(event.batchId, projection);
        }
        const taskId = event.task.id;
        if (event.phase === "queued") {
          projection.set(taskId, { id: taskId, role: event.task.role, status: "queued" });
          const tasks = [...projection.values()];
          await request.record({ kind: "batch", phase: "queued", batch: event.batchId, tasks });
          return;
        }
        const current = projection.get(taskId) ?? { id: taskId, role: event.task.role, status: "queued" as const };
        if (event.phase === "start") {
          current.status = "running";
          current.startedAt = snapshotNow();
          current.updatedAt = current.startedAt;
          applyTelemetry(current, event.telemetry);
          projection.set(taskId, current);
          await request.record({ kind: "batch", phase: "started", batch: event.batchId, tasks: [...projection.values()], taskId });
          return;
        }
        if (event.phase === "update" && event.telemetry) {
          applyTelemetry(current, event.telemetry);
          projection.set(taskId, current);
          await request.record({ kind: "telemetry", target: event.telemetry.target, telemetry: event.telemetry });
          await request.record({ kind: "batch", phase: "updated", batch: event.batchId, tasks: [...projection.values()], taskId });
          return;
        }
        current.status = event.receipt?.status ?? "failed";
        current.summary = event.receipt?.summary;
        current.attempts = event.receipt?.attempts;
        current.updatedAt = snapshotNow();
        if (event.usage) current.usage = event.usage;
        applyTelemetry(current, event.telemetry);
        projection.set(taskId, current);
        const completed = countCompleted(projection);
        if (event.receipt) {
          await request.record({
            kind: "task_settled",
            batch: event.batchId,
            taskId,
            state: {
              task: event.task,
              phase: "terminal",
              attempt: event.receipt.attempts,
              collected: false,
              receipt: event.receipt,
              ...(event.telemetry?.sessionFile ? { sessionFile: event.telemetry.sessionFile } : {}),
            },
            ...(event.telemetry ? { telemetry: event.telemetry } : {}),
          });
        }
        await request.record({ kind: "batch", phase: "completed", batch: event.batchId, tasks: [...projection.values()], taskId });
      };
      const tasks = new WikiTaskRuntime({
        runId: request.runId,
        sourceScopes,
        candidateWikiRoot: request.candidateWikiRoot,
        artifactStore,
        agent: new PiWikiLeafAgent({
          ...sessionOptions,
          skillRoot: request.skillRoot,
          sessionDir: runSessionDirectory,
          budgets,
          sourcePlan: request.sourcePlan,
        }, pageWriter, generation, () => specRecord?.spec, roleModels),
        concurrency: options.concurrency,
        maxDelegatedTasks: budgets?.maxDelegatedTasks,
        maxDelegateBatches: budgets?.maxDelegateBatches,
        restoredState: leadRun.taskRuntimeState,
        transitions: leadRun.taskTransitions,
        writeLease,
        transientRetries,
        baseRetryDelayMs,
        sleep: options.sleep,
        random: options.random,
        now: options.now,
        onTask,
        reportObservability: async (input) => await request.record({ kind: "health", ...input }),
      });
      const policy = pinnedWorkspaceToolPolicy(request.sourcePlan, request.candidateWikiRoot, request.skillRoot);
      await tasks.resume(controller.signal);
      let finishSummary: string | undefined;
      let pause: WikiTaskPauseError | undefined;
      const leadTools = withExecutionModes([
        ...workflowTools(policy, "lead", undefined, request.sourcePlan.sources.map((source) => source.scopeId), undefined, pageWriter),
        planTool(async (input) => {
          const spec = parseWikiSpec(input);
          specRecord = await leadRun.saveSpec(spec, specRecord?.revision ?? 0);
          return { revision: specRecord.revision, pages: wikiSpecPagePaths(spec), directWriteAllowed: leadMayWrite(spec, leadRun.compactionObserved) };
        }),
        delegateStartTool(async (delegated) => {
          assertDelegationAllowed(delegated, specRecord?.spec);
          if (delegated.some((task) => task.role === "review")) writeLease.assertReviewAllowed();
          const queued = await leadRun.queueDelegateBatch(delegated);
          return await tasks.start(queued.contracts, controller.signal);
        }),
        delegateCollectTool(async (batchId, collectOptions) => {
          try {
            return await leadRun.presentSnapshot(await tasks.collect(batchId, collectOptions, controller.signal));
          } catch (error) {
            if (error instanceof WikiTaskPauseError) {
              pause = error;
              controller.abort(error);
            }
            throw error;
          }
        }),
        delegateCancelTool(async (batchId, taskIds, reason) => await leadRun.presentSnapshot(await tasks.cancel(batchId, taskIds, reason))),
        finishTool(async (summary) => {
          if (finishSummary) throw new Error("wiki_finish may be accepted only once");
          if (!summary.trim()) throw new Error("wiki_finish requires a summary");
          if (!specRecord) throw new Error("wiki_finish requires an accepted WikiSpec");
          try {
            tasks.assertFinishable();
          } catch (error) {
            if (error instanceof WikiTaskPauseError) {
              pause = error;
              controller.abort(error);
            }
            throw error;
          }
          await leadRun.assertPublishable(wikiSpecPagePaths(specRecord.spec).map(addWikiPrefix), requiredReviewCoverage);
          finishSummary = boundedDelegateSummary(summary);
        }),
      ]);
      await request.record({ kind: "progress", message: "Wiki Lead is deciding adaptive research and writing tasks" });
      try {
        const maxAttempts = transientRetries + 1;
        const attemptBase = Math.max(request.attempt, request.leadSessionAttempt ?? options.leadSessionAttempt ?? request.attempt);
        for (let retryIndex = 0; retryIndex < maxAttempts; retryIndex += 1) {
          const attempt = attemptBase + retryIndex;
          if (retryIndex > 0) finishSummary = undefined;
          try {
            const leadSessionDir = runSessionDirectory ? path.join(runSessionDirectory, "lead") : undefined;
            const resumeFile = retryIndex === 0
              ? request.leadSessionFile ?? options.leadSessionFile ?? options.sessionFile
              : undefined;
            await runPiSession(policy.workspaceRoot, leadTools, request.prompt, controller.signal, {
              ...sessionOptions,
              sessionDir: leadSessionDir,
              sessionFile: resumeFile,
              skillRoot: request.skillRoot,
              skillName: "wiki-production",
              skillPath: request.skillRoot,
              budgets,
            }, async (telemetry) => {
              if (telemetry.activity === "compacting") await leadRun.observeCompaction();
              await request.record({ kind: "telemetry", target: telemetry.target, telemetry });
            }, { target: { kind: "lead" }, attempt, now: options.now, onHealth: async (input) => await request.record({ kind: "health", ...input }) });
            break;
          } catch (error) {
            if (pause) break;
            const decision = decideWikiAgentAttempt({
              error,
              attempt: retryIndex + 1,
              maxAttempts,
              aborted: request.signal.aborted,
              baseRetryDelayMs,
              random: options.random,
            });
            const failure = decision.failure;
            if (decision.action === "pause") {
              const reason = failure.code === "usage_limit" ? "usage_limit" : "quota";
              pause = new WikiTaskPauseError(reason, failure.message, failure.retryAfterMs);
              controller.abort(pause);
              break;
            }
            if (decision.action !== "retry") throw error;
            const delay = decision.delayMs;
            const sampledAt = snapshotNow();
            const retryTelemetry: WikiAgentTelemetry = {
              target: { kind: "lead" },
              attempt,
              sampledAt,
              activity: "retry_wait",
              activeTools: [],
              lastActivityAt: sampledAt,
              lastHeartbeatAt: sampledAt,
              process: [{
                sequence: attempt,
                at: sampledAt,
                kind: "retry",
                severity: "warning",
                target: { kind: "lead" },
                message: `Fresh Pi session retry scheduled in ${delay}ms`,
                completed: false,
              }],
            };
            await request.record({ kind: "telemetry", target: retryTelemetry.target, telemetry: retryTelemetry });
            await (options.sleep ?? retrySleep)(delay, controller.signal);
          }
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
      if (pause) {
        const retryAt = pause.retryAfterMs === undefined
          ? undefined
          : new Date((options.now ?? Date.now)() + pause.retryAfterMs).toISOString();
        await request.record({ kind: "progress", message: "Wiki Lead paused by provider" });
        return { kind: "pause", reason: pause.reason, summary: pause.message, retryAt };
      }
      if (!finishSummary) throw new Error("Lead agent completed without wiki_finish");
      await request.record({ kind: "progress", message: "Wiki Lead finished" });
      return { kind: "complete", summary: finishSummary };
    },
  };
}

/** Pi Adapter for one delegated leaf; TaskRuntime owns retries and artifact acceptance. */
export class PiWikiLeafAgent implements WikiLeafAgent {
  constructor(
    private readonly options: PiWikiLeadAgentOptions = {},
    private readonly pageWriter?: WikiPageWriter,
    private readonly generation?: WikiGenerationProfile,
    private readonly currentSpec?: () => WikiSpec | undefined,
    private readonly roleModels?: PiWikiRoleModels,
  ) {
    validatedSessionTimeoutMs(options.sessionTimeoutMs);
  }

  async run(task: WikiDelegateContract, context: WikiLeafTaskContext): Promise<WikiLeafResult> {
    if (!this.options.sourcePlan) throw new Error("Pinned source plan is required for Wiki leaf execution");
    const policy = pinnedWorkspaceToolPolicy(this.options.sourcePlan, context.candidateWikiRoot, this.options.skillRoot);
    const artifactHandoffs = Object.entries(context.contextArtifacts).map(([id, ref]) => {
      const file = path.resolve(policy.workspaceRoot, ref.relativePath);
      policy.sourceRoots.set(ref.relativePath, { logicalRoot: file, physicalRoot: file });
      return { id, path: ref.relativePath, sha256: ref.sha256, sizeBytes: ref.sizeBytes };
    });
    const artifactRelativePaths = artifactHandoffs.map((handoff) => handoff.path);
    const declaredSources = [...task.sourceScopeIds, ...artifactRelativePaths];
    const role = task.role === "write" ? "writer" : task.role === "review" ? "reviewer" : "researcher";
    let review: WikiReviewResult | undefined;
    let research: ResearchCompletion | undefined;
    const spec = this.currentSpec?.();
    const reviewIndexes = task.role === "review" && spec
      ? derivedIndexPaths(wikiSpecPagePaths(spec)).map(addWikiPrefix)
      : [];
    const tools = withExecutionModes([
      ...workflowTools(policy, role, task.writePaths, declaredSources, task.reviewPaths, this.pageWriter, reviewIndexes),
      ...(role === "reviewer" ? [reviewFinishTool((result) => {
        if (review) throw new Error("wiki_review_finish may be accepted only once");
        const assigned = new Set(task.reviewPaths ?? []);
        if (result.reviewedPaths.length !== assigned.size || result.reviewedPaths.some((page) => !assigned.has(page))) {
          throw new Error("wiki_review_finish reviewedPaths must exactly match the assigned reviewPaths");
        }
        if (result.findings.some((finding) => !assigned.has(finding.path))) throw new Error("Review finding path is outside the assigned reviewPaths");
        review = result;
      })] : []),
      ...(role === "researcher" ? [researchFinishTool((result) => {
        if (research) throw new Error("wiki_research_finish may be accepted only once");
        research = result;
      })] : []),
    ]);
    const skillDirectory = this.options.skillRoot
      ? path.relative(policy.workspaceRoot, this.options.skillRoot).split(path.sep).join("/")
      : undefined;
    const roleSkillName = `wiki-production-${role}`;
    const roleSkillPath = this.options.skillRoot ? path.join(this.options.skillRoot, "roles", role) : undefined;
    const taskSessionDir = this.options.sessionDir
      ? path.join(this.options.sessionDir, "tasks", String(context.batch), task.id, String(context.attempt))
      : undefined;
    const roleModel = this.roleModels?.[task.role] ?? { model: this.options.model, thinkingLevel: this.options.thinkingLevel };
    const sessionResult = await runPiSession(policy.workspaceRoot, tools, [
        task.instruction,
        leafLanguageInstruction(role, this.options.language),
        `\nReadable source trees (cwd-relative): ${task.sourceScopeIds.join(", ") || "(none)"}`,
        task.writePaths?.length ? `\nExact allowed write paths: ${JSON.stringify(task.writePaths)}` : "",
        task.reviewPaths?.length ? `\nExact required review paths: ${JSON.stringify(task.reviewPaths)}` : "",
        reviewIndexes.length ? `\nRead-only deterministic index paths: ${JSON.stringify(reviewIndexes)}` : "",
        this.generation ? `\nGeneration profile: ${JSON.stringify(this.generation)}. Treat it as reader intent, never as source evidence.` : "",
        role === "writer" ? `\n${writerFrontmatterPrompt(this.generation)}` : "",
        skillDirectory && role === "writer"
          ? `\nFor each assigned pageType, read ${skillDirectory}/references/templates/<pageType>.md before writing.`
          : "",
        artifactHandoffs.length
          ? `\nAccepted context artifacts (read only the ranges needed):\n${artifactHandoffs.map((value) => `- ${value.id}: ${value.path} (${value.sizeBytes} bytes, sha256 ${value.sha256})`).join("\n")}`
          : "",
        "\nComplete the assigned work using the available guarded tools. End with a concise Markdown handoff describing coverage and unresolved gaps.",
      ].join(""), context.signal, {
        ...this.options,
        model: roleModel.model,
        thinkingLevel: roleModel.thinkingLevel,
        sessionDir: taskSessionDir,
        sessionFile: context.sessionFile,
        skillName: roleSkillPath ? roleSkillName : undefined,
        skillPath: roleSkillPath,
      }, context.onTelemetry, {
        target: { kind: "task", batch: context.batch, taskId: task.id },
        attempt: context.attempt,
        onHealth: context.reportObservability,
      });
    const markdown = sessionResult.text.trim();
    if (!markdown) throw new Error("Delegated agent produced empty output");
    if (role === "reviewer" && !review) throw new Error("Reviewer completed without wiki_review_finish");
    if (role === "researcher" && !research) throw new Error("Researcher completed without wiki_research_finish");
    return {
      summary: research?.summary ?? firstLine(markdown),
      markdown,
      usage: sessionResult.usage,
      ...(review ? { review } : {}),
      ...(research ? { status: research.status, coverage: research.coverage, gaps: research.gaps } : {}),
    };
  }
}

async function retrySleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new WikiTaskExecutionError("Wiki retry cancelled", "cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;
const PARALLEL_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

function withExecutionModes(tools: ToolDefinition<any, any, any>[]): ToolDefinition<any, any, any>[] {
  return tools.map((tool) => ({
    ...tool,
    executionMode: PARALLEL_READ_TOOLS.has(tool.name) ? "parallel" : "sequential",
  } as ToolDefinition<any, any, any>));
}

const delegateTaskBase = {
  id: Type.String({ minLength: 1, maxLength: 128 }),
  instruction: Type.String({ minLength: 1 }),
  sourceScopeIds: Type.Array(Type.String()),
  contextRefs: Type.Array(Type.String()),
};

const delegateTaskSchema = Type.Union([
  Type.Object({
    ...delegateTaskBase,
    role: StringEnum(["research"]),
  }, { additionalProperties: false }),
  Type.Object({
    ...delegateTaskBase,
    role: StringEnum(["write"]),
    writePaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...delegateTaskBase,
    role: StringEnum(["review"]),
    reviewPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }, { additionalProperties: false }),
]);

function planTool(save: (spec: unknown) => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_plan",
    label: "Submit Wiki plan",
    description: "Submit the complete versioned WikiSpec before any page is written or reviewed. A revision invalidates prior reviews.",
    promptSnippet: "Submit the complete versioned WikiSpec before writing or reviewing pages",
    promptGuidelines: [
      "Call wiki_plan before writing pages.",
      "wiki_plan overview is a page object, never a string.",
      "wiki_plan page fields are only pageType/path/title/purpose/readerQuestions/requiredFacets/findingIds.",
      "Do not put frontmatter description/type/sources on the wiki_plan Spec.",
      "wiki_plan paths are overview.md, <domain>/domain.md, and child dirs concepts|flows|states|data|modules.",
      "wiki_plan crossLinks/sharedTerms/omissions are arrays; use [] if empty.",
    ],
    parameters: wikiPlanParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      return toolResult(await save((params as { spec: unknown }).spec));
    },
  } as ToolDefinition<any, any, any>;
}

function delegateStartTool(start: (tasks: WikiDelegateTask[]) => Promise<{ batchId: number }>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_start",
    label: "Start Wiki tasks",
    description: "Start one bounded asynchronous batch of Wiki research, writing, or review tasks and return its batch ID immediately.",
    promptSnippet: "Start one bounded asynchronous research, write, or review batch",
    promptGuidelines: [
      "Each instruction must state its goal, scope, expected artifact or page, and stop condition.",
      "When chaining delegated work, populate contextRefs from the exact nodeId values in prior receipt.outputs entries.",
      "Do not mix write and review tasks in one wiki_delegate_start batch.",
      "wiki_delegate_start paths must be current Spec wiki/... paths.",
    ],
    parameters: Type.Object({ tasks: Type.Array(delegateTaskSchema, { minItems: 1 }) }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      const result = await start((params as { tasks: WikiDelegateTask[] }).tasks);
      return toolResult(result);
    },
  } as ToolDefinition<any, any, any>;
}

function delegateCollectTool(
  collect: (batchId: number, options: { until: "any" | "all"; timeoutSeconds: number }) => Promise<WikiDelegateBatchSnapshot>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_collect",
    label: "Collect Wiki tasks",
    description: "Collect completed receipts from an asynchronous Wiki task batch, optionally waiting for any or all pending tasks.",
    promptSnippet: "Collect receipts from a started Wiki task batch",
    promptGuidelines: ["Use timeoutSeconds 0 for a non-blocking status check."],
    parameters: Type.Object({
      batchId: Type.Integer({ minimum: 1 }),
      until: StringEnum(["any", "all"]),
      timeoutSeconds: Type.Integer({ minimum: 0, maximum: 60 }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      const input = params as { batchId: number; until: "any" | "all"; timeoutSeconds: number };
      return toolResult(await collect(input.batchId, { until: input.until, timeoutSeconds: input.timeoutSeconds }));
    },
  } as ToolDefinition<any, any, any>;
}

function delegateCancelTool(
  cancel: (batchId: number, taskIds?: string[], reason?: string) => Promise<WikiDelegateBatchSnapshot>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_cancel",
    label: "Cancel Wiki tasks",
    description: "Cancel pending tasks in an asynchronous Wiki batch, or cancel the whole batch when taskIds is omitted.",
    promptSnippet: "Cancel no-longer-useful Wiki tasks",
    parameters: Type.Object({
      batchId: Type.Integer({ minimum: 1 }),
      taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      const input = params as { batchId: number; taskIds?: string[]; reason?: string };
      return toolResult(await cancel(input.batchId, input.taskIds, input.reason));
    },
  } as ToolDefinition<any, any, any>;
}

function finishTool(finish: (summary: string) => void | Promise<void>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_finish",
    label: "Finish Wiki workflow",
    description: "Finish after the candidate Wiki is complete and sufficiently grounded.",
    promptSnippet: "Finish after the candidate Wiki is complete and reviewed",
    promptGuidelines: [
      "Call wiki_finish only after an accepted WikiSpec and current passing independent reviews.",
      "wiki_finish summary must be 1-1024 characters.",
    ],
    parameters: Type.Object({
      summary: Type.String({
        minLength: 1,
        maxLength: 1024,
        description: "Concise completion summary for the accepted Wiki",
      }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      await finish((params as { summary: string }).summary);
      return toolResult({ accepted: true });
    },
  } as ToolDefinition<any, any, any>;
}

const reviewFindingSchema = Type.Object({
  path: Type.String({ minLength: 1, description: "Assigned candidate path for this finding" }),
  severity: StringEnum(["critical", "major", "minor"], { description: "Finding severity" }),
  message: Type.String({ minLength: 1, description: "What is wrong on the page" }),
  evidence: Type.Array(Type.String({ minLength: 1 }), { description: "Source locators supporting the finding" }),
  suggestion: Type.String({ minLength: 1, description: "Concrete repair the writer should make" }),
}, { additionalProperties: false });

interface ResearchCompletion {
  status: "complete" | "incomplete";
  summary: string;
  coverage: string[];
  gaps: WikiDelegateGap[];
}

const researchGapSchema = Type.Object({
  question: Type.String({ minLength: 1, description: "Unresolved evidence question" }),
  sourceScopeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

function researchFinishTool(finish: (result: ResearchCompletion) => void): ToolDefinition<any, any, any> {
  return {
    name: "wiki_research_finish",
    label: "Finish Wiki research",
    description: "Submit structured coverage and gaps for the Markdown research handoff that the host will persist.",
    promptSnippet: "Submit the structured research completion receipt",
    parameters: Type.Object({
      status: StringEnum(["complete", "incomplete"]),
      summary: Type.String({ minLength: 1, maxLength: 1024 }),
      coverage: Type.Array(Type.String({ minLength: 1 })),
      gaps: Type.Array(researchGapSchema),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      finish(params as ResearchCompletion);
      return toolResult({ accepted: true });
    },
  } as ToolDefinition<any, any, any>;
}

function reviewFinishTool(finish: (result: WikiReviewResult) => void): ToolDefinition<any, any, any> {
  return {
    name: "wiki_review_finish",
    label: "Finish Wiki review",
    description: "Submit the independent structured verdict for every assigned candidate path and required profile review item.",
    promptSnippet: "Submit the independent structured review verdict",
    promptGuidelines: [
      "wiki_review_finish reviewedPaths must exactly match the assigned reviewPaths.",
    ],
    parameters: Type.Object({
      verdict: StringEnum(["pass", "changes_requested"], { description: "Independent review verdict for the assigned paths" }),
      reviewedPaths: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Exact assigned reviewPaths that were reviewed",
      }),
      findings: Type.Array(reviewFindingSchema, { description: "Issues found on assigned paths" }),
      profileCoverage: Type.Array(Type.String({ minLength: 1 }), { description: "Generation-profile review items covered" }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      finish(params as WikiReviewResult);
      return toolResult({ accepted: true });
    },
  } as ToolDefinition<any, any, any>;
}

function leafLanguageInstruction(role: "researcher" | "writer" | "reviewer", language?: "zh" | "en"): string {
  if (role === "researcher") {
    return "\nWrite the Markdown handoff as concise model-readable analysis. It does not need to use the Wiki reader language. Keep code identifiers and citations unchanged.";
  }
  return language === "zh"
    ? "\nUse Simplified Chinese for reader-facing Wiki content and the handoff. Keep code identifiers and citations unchanged."
    : "\nUse English for reader-facing Wiki content and the handoff. Keep code identifiers and citations unchanged.";
}

function writerFrontmatterPrompt(generation?: WikiGenerationProfile): string {
  const required = generation?.templates.requiredSections ?? [];
  return [
    "Write each assigned Wiki page with this frontmatter shape:",
    "---",
    "type: Domain",
    "title: Example",
    "description: One-sentence reader summary",
    "sources:",
    "  - id: source-a",
    "    resource: repo:source/path.ts#L1-L1",
    "---",
    "Frontmatter type must match the WikiSpec pageType (Overview/Domain/Architecture/Module/Flow/Concept/State/Data).",
    required.length ? `Required sections: ${required.join(", ")}.` : "",
  ].filter((line) => line.length > 0).join("\n");
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim() || "Delegated task completed";
}

function countCompleted(snapshots: Map<string, WikiTaskSnapshot>): number {
  return [...snapshots.values()].filter((task) => task.status === "complete" || task.status === "incomplete" || task.status === "failed").length;
}

function applyTelemetry(snapshot: WikiTaskSnapshot, telemetry?: WikiAgentTelemetry): void {
  if (!telemetry) return;
  snapshot.attempt = telemetry.attempt;
  snapshot.updatedAt = telemetry.sampledAt;
  if (telemetry.activity) snapshot.activity = taskActivity(telemetry.activity);
  snapshot.activeTool = telemetry.activeTools?.at(-1);
  if (telemetry.usage) snapshot.usage = telemetry.usage;
}

function stripWikiPrefix(value: string): string {
  if (!value.startsWith("wiki/")) throw new Error(`Wiki path must start with wiki/: ${value}`);
  return value.slice("wiki/".length);
}

function addWikiPrefix(value: string): string { return `wiki/${value}`; }

function leadMayWrite(spec: WikiSpec, compacted: boolean): boolean {
  return !compacted && spec.domains.length === 1 && wikiSpecPages(spec).length <= 3;
}

function assertDelegationAllowed(tasks: readonly WikiDelegateTask[], spec: WikiSpec | undefined): void {
  if (tasks.some((task) => task.role === "write") && tasks.some((task) => task.role === "review")) {
    throw new Error("A wiki_delegate_start batch may not mix write and review tasks");
  }
  for (const task of tasks) {
    if (task.role === "research") continue;
    if (!spec) throw new Error(`Submit an accepted WikiSpec before delegating ${task.role} tasks`);
    const declared = new Set(wikiSpecPagePaths(spec).map(addWikiPrefix));
    const paths = task.role === "write" ? task.writePaths : task.reviewPaths;
    for (const page of paths ?? []) {
      if (!declared.has(page)) throw new Error(`Delegated ${task.role} path is not declared by the current WikiSpec: ${page}`);
    }
  }
}

function taskActivity(activity: NonNullable<WikiAgentTelemetry["activity"]>): NonNullable<WikiTaskSnapshot["activity"]> {
  if (activity === "compacting") return "compacting";
  if (activity === "using_tool" || activity === "delegating" || activity === "finishing") return "tool";
  if (activity === "settled") return "idle";
  return "responding";
}

async function runSessionWithDeadline(
  session: AgentSession,
  prompt: string,
  signal: AbortSignal,
  timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void session.abort();
      reject(new WikiTaskExecutionError(`Wiki agent session timed out after ${timeoutMs}ms`, "timeout"));
    }, timeoutMs);
  });
  try {
    if (signal.aborted) throw new WikiTaskExecutionError("Wiki agent session cancelled", "cancelled");
    await Promise.race([session.prompt(prompt), deadline]);
    await Promise.race([session.waitForIdle(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validatedSessionTimeoutMs(timeoutMs = DEFAULT_SESSION_TIMEOUT_MS): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_SESSION_TIMEOUT_MS) {
    throw new Error(`sessionTimeoutMs must be an integer from 1000 to ${MAX_SESSION_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

async function runPiSession(
  cwd: string,
  tools: ToolDefinition<any, any, any>[],
  prompt: string,
  signal: AbortSignal,
  options: PiWikiLeadAgentOptions,
  onTelemetry?: (telemetry: WikiAgentTelemetry) => void | Promise<void>,
  observer?: ObserverContext,
): Promise<{ text: string; usage?: WikiContextStats }> {
  // TaskRuntime owns configurable transient retries by creating fresh sessions.
  // Disable both Pi turn retry and provider request retry so budgets cannot multiply.
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: false, maxRetries: PI_SESSION_REQUEST_RETRIES, provider: { maxRetries: PI_SESSION_REQUEST_RETRIES } },
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: options.skillPath ? [options.skillPath] : [],
  });
  await loader.reload();
  if (options.skillName) {
    const skills = loader.getSkills().skills;
    if (skills.length !== 1 || skills[0].name !== options.skillName) {
      throw new Error(`Required Wiki production skill is unavailable: ${options.skillName}`);
    }
  }
  const sessionFile = options.sessionFile;
  const sessionManager = sessionFile
    ? SessionManager.open(sessionFile, options.sessionDir, cwd)
    : SessionManager.create(cwd, options.sessionDir);
  let session: AgentSession | undefined;
  let budgetError: WikiBudgetExhaustedError | undefined;
  let toolCalls = 0;
  const guardedTools = tools.map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      async execute(toolCallId, params, toolSignal, onUpdate, context) {
        const limit = options.budgets?.maxToolCallsPerSession;
        if (limit !== undefined && toolCalls >= limit) {
          budgetError = sessionToolBudgetError(limit, toolCalls);
          void session?.abort();
          throw budgetError;
        }
        toolCalls += 1;
        return await execute(toolCallId, params, toolSignal, onUpdate, context);
      },
    } as ToolDefinition<any, any, any>;
  });
  const createOptions: CreateAgentSessionOptions = {
    cwd,
    sessionManager,
    settingsManager: settings,
    resourceLoader: loader,
    noTools: "builtin",
    tools: guardedTools.map((tool) => tool.name),
    customTools: guardedTools,
    ...(!sessionFile ? { model: options.model, thinkingLevel: options.thinkingLevel } : {}),
  };
  const created = await (options.createSession ?? createAgentSession)(createOptions);
  session = created.session;
  if (created.modelFallbackMessage) {
    session.dispose();
    throw new Error(`Could not restore the persisted Wiki model: ${created.modelFallbackMessage}`);
  }
  const sessionObserver = onTelemetry && observer
    ? new PiSessionObserver(session, {
      ...observer,
      timeoutMs: options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      workspaceRoot: cwd,
      report: onTelemetry,
      onHealth: observer.onHealth,
    })
    : undefined;
  const abort = () => { void session.abort(); };
  const initialUsage = readSessionUsage(session);
  let turns = initialUsage?.turns ?? 0;
  toolCalls = initialUsage?.toolCalls ?? 0;
  if (options.budgets && turns >= options.budgets.maxTurnsPerSession) {
    session.dispose();
    throw sessionTurnBudgetError(options.budgets.maxTurnsPerSession, turns);
  }
  if (options.budgets && toolCalls >= options.budgets.maxToolCallsPerSession) {
    session.dispose();
    throw sessionToolBudgetError(options.budgets.maxToolCallsPerSession, toolCalls);
  }
  const stopBudgetMonitor = typeof session.subscribe === "function"
    ? session.subscribe((event) => {
      if (event.type === "turn_end") turns += 1;
      if (event.type === "turn_start" && !budgetError && options.budgets && turns >= options.budgets.maxTurnsPerSession) {
        budgetError = sessionTurnBudgetError(options.budgets.maxTurnsPerSession, turns);
      }
      if (budgetError) void session.abort();
    })
    : undefined;
  signal.addEventListener("abort", abort, { once: true });
  try {
    sessionObserver?.start();
    try {
      const expandedPrompt = options.skillName ? `/skill:${options.skillName} ${prompt}` : prompt;
      await runSessionWithDeadline(session, expandedPrompt, signal, options.sessionTimeoutMs);
    } catch (error) {
      const failure = budgetError ?? (signal.aborted ? sessionAbortReason(signal) : error);
      await sessionObserver?.failed(failure);
      throw failure;
    }
    if (budgetError) throw budgetError;
    if (signal.aborted) throw sessionAbortReason(signal);
    const stateError = typeof session.state.errorMessage === "string" ? session.state.errorMessage : undefined;
    if (stateError) throw new Error(stateError);
    const text = session.getLastAssistantText() ?? "";
    return { text, usage: readSessionUsage(session) };
  } finally {
    signal.removeEventListener("abort", abort);
    stopBudgetMonitor?.();
    await sessionObserver?.stop();
    session.dispose();
  }
}

function sessionAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === "string" && signal.reason.trim()
    ? signal.reason
    : "Wiki agent session cancelled";
  return new WikiTaskExecutionError(message, "cancelled", { cause: signal.reason });
}

function sessionTurnBudgetError(limit: number, turns: number): WikiBudgetExhaustedError {
  return new WikiBudgetExhaustedError(
    `Pi session turn limit exhausted (${limit})`,
    "session_turns_exhausted",
    { limit, turns },
  );
}

function sessionToolBudgetError(limit: number, toolCalls: number): WikiBudgetExhaustedError {
  return new WikiBudgetExhaustedError(
    `Pi session tool-call limit exhausted (${limit})`,
    "session_tool_calls_exhausted",
    { limit, toolCalls },
  );
}

type ObserverContext = {
  target: WikiAgentTelemetry["target"];
  attempt: number;
  now?: () => number;
  onHealth?: PiSessionObserverOptions["onHealth"];
};
