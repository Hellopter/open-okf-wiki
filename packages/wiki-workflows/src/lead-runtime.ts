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
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { workflowTools, workspaceToolPolicy, type WikiWriteControl } from "./agent-tools.js";
import { createWikiArtifactStore, type WikiArtifactStore } from "./artifact-store.js";
import { boundedDelegateSummary, WikiTaskExecutionError, WikiTaskPauseError, type WikiDelegateBatchReceipt, type WikiDelegateTask } from "./delegate-contracts.js";
import type { WikiAgentTelemetry, WikiContextStats, WikiLeadRuntime, WikiTaskSnapshot } from "./producer-types.js";
import { PiSessionObserver, readSessionUsage, type PiSessionObserverOptions } from "./pi-session-observer.js";
import { classifyTaskFailure, WikiTaskRuntime, type WikiLeafAgent, type WikiLeafResult, type WikiLeafTaskContext, type WikiTaskProgressEvent } from "./task-runtime.js";
import { createWikiRunSpecStore, type WikiRunSpecRecord } from "./run-spec-store.js";
import {
  parseWikiSpec,
  wikiPlanParameters,
  wikiSpecPagePaths,
  wikiSpecPages,
  type WikiSpec,
} from "./wiki-spec.js";
import { canonicalizeWikiPageContent, derivedIndexPaths, formatIssue, validateWikiPageContent } from "./wiki-validate.js";
import { WikiWorkflowState, type WikiReviewResult } from "./workflow-state.js";
import path from "node:path";
import { materializeValidatedWikiIndexes } from "./wiki-finalize.js";
import { wikiRoleBrief } from "./skill-briefs.js";
import type { WikiGenerationProfile } from "./workspace.js";

const PI_SESSION_REQUEST_RETRIES = 0;
const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60_000;
const MAX_SESSION_TIMEOUT_MS = 2_147_483_647;

export interface PiWikiLeadAgentOptions {
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  language?: "zh" | "en";
  createSession?: (options: CreateAgentSessionOptions) => ReturnType<typeof createAgentSession>;
  /** Hard deadline for each Lead or delegated Pi session. Default 20 minutes. */
  sessionTimeoutMs?: number;
  /** Materialized production skill root inside the workspace. */
  skillRoot?: string;
}

export interface CreatePiLeadRuntimeOptions extends PiWikiLeadAgentOptions {
  concurrency?: number;
  transientRetries?: number;
  baseRetryDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Complete reusable production Adapter for WikiProducer's model-facing seam. */
export function createPiLeadRuntime(options: CreatePiLeadRuntimeOptions = {}): WikiLeadRuntime {
  const transientRetries = options.transientRetries ?? 1;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
  if (!Number.isInteger(transientRetries) || transientRetries < 0) throw new Error("transientRetries must be a non-negative integer");
  if (!Number.isFinite(baseRetryDelayMs) || baseRetryDelayMs < 0) throw new Error("baseRetryDelayMs must be non-negative");
  const sessionTimeoutMs = validatedSessionTimeoutMs(options.sessionTimeoutMs);
  const sessionOptions = {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    createSession: options.createSession,
    sessionTimeoutMs,
    language: options.language,
  };
  return {
    async run(request) {
      const specStore = createWikiRunSpecStore({ workspace: request.cwd });
      let specRecord = await specStore.read(request.runId);
      const workflowState = await WikiWorkflowState.open(request.cwd, request.runId);
      const generation = request.generation;
      const requiredSections = generation.templates.requiredSections;
      const requiredReviewCoverage = generation.review.mustCover;
      const candidateDirectory = path.relative(request.cwd, request.candidateWikiRoot).split(path.sep).join("/");
      const tryIndexes = async (): Promise<boolean> => {
        if (!specRecord) return false;
        try {
          await materializeValidatedWikiIndexes(request.cwd, specRecord.spec, candidateDirectory, undefined, requiredSections);
          return true;
        } catch {
          return false;
        }
      };
      const writeControl: WikiWriteControl = {
        async prepare(pagePath, content, role) {
          if (!specRecord) throw new Error("Submit an accepted WikiSpec with wiki_plan before writing Wiki pages");
          const relative = stripWikiPrefix(pagePath);
          const page = wikiSpecPages(specRecord.spec).find((candidate) => candidate.path === relative);
          if (!page) throw new Error(`Wiki page is not declared by the current WikiSpec: ${pagePath}`);
          if (role === "lead" && !leadMayWrite(specRecord.spec, workflowState.compactionObserved)) {
            throw new Error("Lead direct writing is disabled for this WikiSpec or after context compaction; delegate an exact-path writer");
          }
          const issues = await validateWikiPageContent(request.cwd, specRecord.spec, relative, content, candidateDirectory, undefined, requiredSections);
          if (issues.length) throw new Error(`Wiki page validation failed before write: ${issues.map(formatIssue).join("; ")}`);
          const canonical = canonicalizeWikiPageContent(content);
          await workflowState.beginWrite();
          return canonical;
        },
        async committed() { await tryIndexes(); },
      };
      const artifactStore = createWikiArtifactStore({ workspace: request.cwd });
      const sourceScopes = Object.fromEntries(request.sourceScopeIds.map((id) => [id, id]));
      let batch = 0;
      let batchTotal = 0;
      const batchTasks = new Map<string, WikiTaskSnapshot>();
      const snapshotNow = () => new Date((options.now ?? Date.now)()).toISOString();
      const onTask = async (event: WikiTaskProgressEvent): Promise<void> => {
        const taskId = event.task.id;
        if (event.phase === "queued") {
          batchTasks.set(taskId, { id: taskId, role: event.task.role, status: "queued" });
          const tasks = [...batchTasks.values()];
          await request.report(`Delegated ${tasks.map((task) => task.id).join(", ")}`, {
            stage: "lead",
            batch,
            total: batchTotal,
            completed: 0,
            tasks,
          });
          return;
        }
        const current = batchTasks.get(taskId) ?? { id: taskId, role: event.task.role, status: "queued" as const };
        if (event.phase === "start") {
          current.status = "running";
          current.startedAt = snapshotNow();
          current.updatedAt = current.startedAt;
          applyTelemetry(current, event.telemetry);
          batchTasks.set(taskId, current);
          await request.report(`${event.task.role} ${taskId} started`, {
            stage: "lead",
            batch,
            total: batchTotal,
            completed: countCompleted(batchTasks),
            tasks: [...batchTasks.values()],
            taskId,
          });
          return;
        }
        if (event.phase === "update" && event.telemetry) {
          applyTelemetry(current, event.telemetry);
          batchTasks.set(taskId, current);
          await request.report(`${event.task.role} ${taskId} telemetry`, {
            stage: "lead",
            batch,
            total: batchTotal,
            completed: countCompleted(batchTasks),
            tasks: [...batchTasks.values()],
            taskId,
            phase: "update",
            telemetry: event.telemetry,
          });
          return;
        }
        current.status = event.receipt?.status ?? "failed";
        current.summary = event.receipt?.summary;
        current.attempts = event.receipt?.attempts;
        current.updatedAt = snapshotNow();
        if (event.usage) current.usage = event.usage;
        applyTelemetry(current, event.telemetry);
        batchTasks.set(taskId, current);
        const completed = countCompleted(batchTasks);
        await request.report(`${event.task.role} ${taskId} ${current.status}`, {
          stage: "lead",
          batch,
          total: batchTotal,
          completed,
          tasks: [...batchTasks.values()],
          taskId,
          receipt: event.receipt,
          usage: event.usage,
        });
      };
      const tasks = new WikiTaskRuntime({
        runId: request.runId,
        cwd: request.cwd,
        sourceScopes,
        candidateWikiRoot: request.candidateWikiRoot,
        artifactStore,
        agent: new PiWikiLeafAgent(artifactStore, { ...sessionOptions, skillRoot: request.skillRoot }, writeControl, generation, () => specRecord?.spec),
        concurrency: options.concurrency,
        transientRetries,
        baseRetryDelayMs,
        sleep: options.sleep,
        random: options.random,
        now: options.now,
        onTask,
        reportObservability: request.reportObservability,
      });
      const policy = await workspaceToolPolicy(request.cwd, request.candidateWikiRoot, request.skillRoot);
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) controller.abort();
      let finishSummary: string | undefined;
      let pause: WikiTaskPauseError | undefined;
      let delegateBatches = 0;
      let transition = Promise.resolve();
      const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
        const previous = transition;
        let release!: () => void;
        transition = new Promise<void>((resolve) => { release = resolve; });
        await previous.catch(() => {});
        try { return await operation(); } finally { release(); }
      };
      const leadTools = [
        ...workflowTools(policy, "lead", undefined, request.sourceScopeIds, undefined, writeControl),
        planTool(async (input) => await serialize(async () => {
          const spec = parseWikiSpec(input);
          specRecord = await specStore.save(request.runId, spec, specRecord?.revision ?? 0);
          await workflowState.invalidateReviews();
          await tryIndexes();
          return { revision: specRecord.revision, pages: wikiSpecPagePaths(spec), directWriteAllowed: leadMayWrite(spec, workflowState.compactionObserved) };
        })),
        delegateTool(async (delegated) => await serialize(async () => {
          try {
            assertDelegationAllowed(delegated, specRecord?.spec);
            if (delegated.some((task) => task.role === "review") && !await tryIndexes()) {
              throw new Error("Review requires every current WikiSpec page to validate and deterministic indexes to be materialized");
            }
            const captured = workflowState.snapshot(specRecord!.revision);
            batch += 1;
            batchTotal = delegated.length;
            batchTasks.clear();
            const receipt = await tasks.delegate(delegated, controller.signal);
            for (const reviewed of receipt.receipts.filter((item) => item.role === "review" && item.status === "complete" && item.review)) {
              const accepted = await workflowState.acceptReview(reviewed.id, captured, specRecord?.revision ?? 0, reviewed.review!);
              if (!accepted) {
                reviewed.status = "incomplete";
                reviewed.summary = "Review became stale while the delegated task was running";
                reviewed.review = undefined;
              }
            }
            delegateBatches += 1;
            return receipt;
          } catch (error) {
            if (error instanceof WikiTaskPauseError) {
              pause = error;
              controller.abort();
            }
            throw error;
          }
        })),
        finishTool((summary) => {
          if (finishSummary) throw new Error("wiki_finish may be accepted only once");
          if (!summary.trim()) throw new Error("wiki_finish requires a summary");
          if (!specRecord) throw new Error("wiki_finish requires an accepted WikiSpec");
          workflowState.assertPublishable(specRecord.revision, wikiSpecPagePaths(specRecord.spec).map(addWikiPrefix), requiredReviewCoverage);
          finishSummary = boundedDelegateSummary(summary);
        }),
      ];
      await request.report("Wiki Lead is deciding adaptive research and writing tasks", { stage: "lead", sourceScopeCount: Object.keys(sourceScopes).length });
      try {
        const maxAttempts = transientRetries + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          if (attempt > 1) finishSummary = undefined;
          try {
            await runPiSession(policy.workspaceRoot, leadTools, request.prompt, controller.signal, sessionOptions, async (telemetry) => {
              if (telemetry.activity === "compacting") await workflowState.observeCompaction();
              await request.report("Wiki Lead telemetry", { phase: "agent_update", telemetry });
            }, { target: { kind: "lead" }, attempt, now: options.now, onHealth: request.reportObservability });
            break;
          } catch (error) {
            if (pause) break;
            const failure = classifyTaskFailure(error, request.signal.aborted);
            if (failure.code === "quota" || failure.code === "usage_limit") {
              pause = new WikiTaskPauseError(failure.code, failure.message, failure.retryAfterMs);
              break;
            }
            if (!failure.retryable || attempt >= maxAttempts) throw error;
            const delay = failure.code === "rate_limit" && failure.retryAfterMs !== undefined
              ? failure.retryAfterMs
              : retryDelay(baseRetryDelayMs, attempt, options.random ?? Math.random);
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
            await request.report("Wiki Lead retry scheduled", { phase: "agent_update", telemetry: retryTelemetry });
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
        await request.report("Wiki Lead paused by provider", { reason: pause.reason, retryAt });
        return { kind: "pause", reason: pause.reason, summary: pause.message, retryAt };
      }
      if (!finishSummary) throw new Error("Lead agent completed without wiki_finish");
      await request.report("Wiki Lead finished", { delegateBatches });
      return { kind: "complete", summary: finishSummary };
    },
  };
}

/** Pi Adapter for one delegated leaf; TaskRuntime owns retries and artifact acceptance. */
export class PiWikiLeafAgent implements WikiLeafAgent {
  constructor(
    private readonly artifacts: WikiArtifactStore,
    private readonly options: PiWikiLeadAgentOptions = {},
    private readonly writeControl?: WikiWriteControl,
    private readonly generation?: WikiGenerationProfile,
    private readonly currentSpec?: () => WikiSpec | undefined,
  ) {
    validatedSessionTimeoutMs(options.sessionTimeoutMs);
  }

  async run(task: WikiDelegateTask, context: WikiLeafTaskContext): Promise<WikiLeafResult> {
    const policy = await workspaceToolPolicy(context.cwd, context.candidateWikiRoot, this.options.skillRoot);
    const declaredSources = Object.values(context.sourceRoots);
    const role = task.role === "write" ? "writer" : task.role === "review" ? "reviewer" : "researcher";
    let review: WikiReviewResult | undefined;
    const spec = this.currentSpec?.();
    const reviewIndexes = task.role === "review" && spec
      ? derivedIndexPaths(wikiSpecPagePaths(spec)).map(addWikiPrefix)
      : [];
    const tools = [
      ...workflowTools(policy, role, task.writePaths, declaredSources, task.reviewPaths, this.writeControl, reviewIndexes),
      ...(role === "reviewer" ? [reviewFinishTool((result) => {
        if (review) throw new Error("wiki_review_finish may be accepted only once");
        const assigned = new Set(task.reviewPaths ?? []);
        if (result.reviewedPaths.length !== assigned.size || result.reviewedPaths.some((page) => !assigned.has(page))) {
          throw new Error("wiki_review_finish reviewedPaths must exactly match the assigned reviewPaths");
        }
        if (result.findings.some((finding) => !assigned.has(finding.path))) throw new Error("Review finding path is outside the assigned reviewPaths");
        review = result;
      })] : []),
    ];
    const handoffs = await Promise.all(Object.entries(context.contextArtifacts).map(async ([id, ref]) => ({
      id,
      artifact: ref.relativePath,
      content: await this.artifacts.read(ref),
    })));
    const skillDirectory = this.options.skillRoot
      ? path.relative(policy.workspaceRoot, this.options.skillRoot).split(path.sep).join("/")
      : undefined;
    const sessionResult = await runPiSession(policy.workspaceRoot, tools, [
        task.instruction,
        leafLanguageInstruction(role, this.options.language),
        task.writePaths?.length ? `\nExact allowed write paths: ${JSON.stringify(task.writePaths)}` : "",
        task.reviewPaths?.length ? `\nExact required review paths: ${JSON.stringify(task.reviewPaths)}` : "",
        reviewIndexes.length ? `\nRead-only deterministic index paths: ${JSON.stringify(reviewIndexes)}` : "",
        this.generation ? `\nGeneration profile: ${JSON.stringify(this.generation)}. Treat it as reader intent, never as source evidence.` : "",
        role === "writer" ? `\n${writerFrontmatterPrompt(this.generation)}` : "",
        skillDirectory && role === "writer"
          ? `\nFor each assigned pageType, read ${skillDirectory}/references/templates/<pageType>.md before writing.`
          : "",
        this.options.skillRoot ? `\n${wikiRoleBrief(this.options.skillRoot, role)}` : "",
        handoffs.length ? `\nAccepted context artifacts:\n${handoffs.map((value) => `## ${value.id} (${value.artifact})\n${value.content}`).join("\n\n")}` : "",
        "\nComplete the assigned work using the available guarded tools. End with a concise Markdown handoff describing coverage and unresolved gaps.",
      ].join(""), context.signal, this.options, context.onTelemetry, {
        target: { kind: "task", batch: context.batch, taskId: task.id },
        attempt: context.attempt,
        onHealth: context.reportObservability,
      });
    const markdown = sessionResult.text.trim();
    if (!markdown) throw new Error("Delegated agent produced empty output");
    if (role === "reviewer" && !review) throw new Error("Reviewer completed without wiki_review_finish");
    return { summary: firstLine(markdown), markdown, usage: sessionResult.usage, ...(review ? { review } : {}) };
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

function retryDelay(baseRetryDelayMs: number, attempt: number, random: () => number): number {
  return Math.floor(random() * baseRetryDelayMs * (2 ** Math.max(0, attempt - 1)));
}

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;

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

function delegateTool(delegate: (tasks: WikiDelegateTask[]) => Promise<WikiDelegateBatchReceipt>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate",
    label: "Delegate Wiki tasks",
    description: "Run one bounded batch of Wiki research, writing, or review tasks. Returns small receipts and artifact handles; failed branches do not discard successful branches.",
    promptSnippet: "Run one bounded research, write, or review batch",
    promptGuidelines: [
      "Do not mix write and review tasks in one wiki_delegate batch.",
      "wiki_delegate paths must be current Spec wiki/... paths.",
    ],
    parameters: Type.Object({ tasks: Type.Array(delegateTaskSchema, { minItems: 1 }) }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      const result = await delegate((params as { tasks: WikiDelegateTask[] }).tasks);
      return toolResult(result);
    },
  } as ToolDefinition<any, any, any>;
}

function finishTool(finish: (summary: string) => void): ToolDefinition<any, any, any> {
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
      finish((params as { summary: string }).summary);
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
    throw new Error("A wiki_delegate batch may not mix write and review tasks");
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
  });
  await loader.reload();
  const created = await (options.createSession ?? createAgentSession)({
    cwd,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
    resourceLoader: loader,
    noTools: "builtin",
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  });
  const session: AgentSession = created.session;
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
  signal.addEventListener("abort", abort, { once: true });
  try {
    session.setAutoCompactionEnabled(true);
    session.setAutoRetryEnabled(false);
    sessionObserver?.start();
    try {
      await runSessionWithDeadline(session, prompt, signal, options.sessionTimeoutMs);
    } catch (error) {
      await sessionObserver?.failed(error);
      throw error;
    }
    if (signal.aborted) throw new WikiTaskExecutionError("Wiki agent session cancelled", "cancelled");
    const stateError = typeof session.state.errorMessage === "string" ? session.state.errorMessage : undefined;
    if (stateError) throw new Error(stateError);
    const text = session.getLastAssistantText() ?? "";
    return { text, usage: readSessionUsage(session) };
  } finally {
    signal.removeEventListener("abort", abort);
    await sessionObserver?.stop();
    session.dispose();
  }
}

type ObserverContext = {
  target: WikiAgentTelemetry["target"];
  attempt: number;
  now?: () => number;
  onHealth?: PiSessionObserverOptions["onHealth"];
};
