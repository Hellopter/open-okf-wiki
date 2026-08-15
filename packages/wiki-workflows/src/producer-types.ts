import type { WikiGenerationProfile, WikiRoleModelConfig } from "./workspace.js";
import type { WikiSpec } from "./wiki-spec.js";
import type { WikiArtifactRef } from "./artifact-store.js";
import type { WikiDelegateError, WikiDelegateGap, WikiDelegateReceipt, WikiDelegateTask } from "./delegate-contracts.js";

export type WikiProducerOperation = "update" | "regenerate";

export type WikiRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type WikiRunControl = "pause" | "resume" | "cancel";

export const WIKI_MANUAL_PAUSE = Symbol.for("okf-wiki.manual-pause");

export interface WikiProducerRequest {
  cwd: string;
  operation?: WikiProducerOperation;
  focus?: string;
}

export interface WikiRunEvent {
  version: 1;
  runId: string;
  sequence: number;
  at: string;
  type: "started" | "progress" | "telemetry" | "paused" | "resumed" | "cancelled" | "completed" | "failed";
  message: string;
  data?: Record<string, unknown>;
}

export type WikiRunStage = "prepare" | "lead" | "validate" | "publish";

export interface WikiContextStats {
  turns?: number;
  toolCalls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  model?: string;
}

export interface WikiTaskSnapshot {
  id: string;
  role: "research" | "write" | "review";
  status: "queued" | "running" | "complete" | "incomplete" | "failed";
  health?: "healthy" | "degraded";
  summary?: string;
  attempts?: number;
  attempt?: number;
  startedAt?: string;
  updatedAt?: string;
  activity?: WikiTaskActivity;
  activeTool?: WikiActiveTool;
  usage?: WikiContextStats;
}

export type WikiTaskActivity = "responding" | "tool" | "idle" | "compacting";

export interface WikiActiveTool {
  id?: string;
  name: string;
  startedAt: string;
  summary?: string;
}

export type WikiAgentTarget =
  | { kind: "lead" }
  | { kind: "task"; batch: number; taskId: string };

export type WikiAgentStatus = "queued" | "running" | "retrying" | "complete" | "incomplete" | "failed" | "cancelled";

export type WikiAgentActivity = WikiTaskActivity
  | "starting"
  | "waiting_model"
  | "streaming"
  | "using_tool"
  | "delegating"
  | "synthesizing"
  | "retry_wait"
  | "finishing"
  | "settled";

export interface WikiAgentSnapshot {
  target: WikiAgentTarget;
  role: "lead" | WikiTaskSnapshot["role"];
  status: WikiAgentStatus;
  attempt: number;
  activity: WikiAgentActivity;
  activeTools: WikiActiveTool[];
  health: "healthy" | "degraded";
  startedAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  lastHeartbeatAt?: string;
  deadlineAt?: string;
  usage?: WikiContextStats;
  summary?: string;
}

export type WikiActivityKind = "stage" | "agent" | "tool" | "batch" | "retry" | "compaction" | "warning" | "failure";

export interface WikiActivityEntry {
  sequence: number;
  at: string;
  kind: WikiActivityKind;
  severity: "info" | "warning" | "error";
  target?: WikiAgentTarget;
  message: string;
  toolCallId?: string;
  toolName?: string;
  summary?: string;
  durationMs?: number;
  completed?: boolean;
}

export interface WikiDelegationBatchSummary {
  batch: number;
  status: "running" | "complete" | "partial" | "failed";
  completed: number;
  total: number;
  startedAt?: string;
  completedAt?: string;
  tasks: WikiTaskSnapshot[];
}

/** Normalized checkpoint emitted by a Pi session observer. */
export interface WikiAgentTelemetry {
  target: WikiAgentTarget;
  attempt: number;
  sampledAt: string;
  activity?: WikiAgentActivity;
  activeTools?: WikiActiveTool[];
  lastActivityAt?: string;
  lastHeartbeatAt?: string;
  deadlineAt?: string;
  usage?: WikiContextStats;
  process?: WikiActivityEntry[];
  /** Pi-managed persistent session file for exact resume. */
  sessionFile?: string;
}

export interface WikiExecutionBudgets {
  maxDelegatedTasks: number;
  maxDelegateBatches: number;
  maxTurnsPerSession: number;
  maxToolCallsPerSession: number;
}

export interface WikiTaskRuntimePartial {
  outputs: WikiArtifactRef[];
  coverage: string[];
  gaps: WikiDelegateGap[];
}

export interface WikiTaskRuntimeExecution {
  task: WikiDelegateTask;
  phase: "queued" | "running" | "paused" | "terminal";
  attempt: number;
  collected: boolean;
  /** Provider pause details; manual pauses intentionally have no task failure. */
  pause?: WikiDelegateError;
  partial?: WikiTaskRuntimePartial;
}

export interface WikiTaskRuntimeTaskState extends WikiTaskRuntimeExecution {
  sessionFile?: string;
  receipt?: WikiDelegateReceipt;
}

export interface WikiTaskRuntimeBatchState {
  batchId: number;
  tasks: WikiTaskRuntimeTaskState[];
}

export interface WikiTaskRuntimeState {
  batches: WikiTaskRuntimeBatchState[];
}

export interface WikiAgentExecution extends WikiTaskRuntimeExecution {
  batchId: number;
}

export interface WikiRunProgress {
  stage: WikiRunStage;
  lead?: WikiAgentSnapshot;
  currentBatch?: WikiDelegationBatchSummary;
  batches?: WikiDelegationBatchSummary[];
  recentActivity?: WikiActivityEntry[];
  language?: "zh" | "en";
  lastMessage?: string;
  /** Aggregate terminal/current usage, deduplicated by Agent target and attempt. */
  usage?: WikiContextStats;
  budgets?: WikiExecutionBudgets;
}

export interface WikiAgentInspection {
  runId: string;
  agent: WikiAgentSnapshot;
  process: WikiActivityEntry[];
  receipt?: import("./delegate-contracts.js").WikiDelegateReceipt;
  handoff?: string;
  handoffPath?: string;
}

/** Durable bounded process record for either the lead or one delegated task. */
export interface WikiAgentRecord {
  agent: WikiAgentSnapshot;
  process: WikiActivityEntry[];
  receipt?: import("./delegate-contracts.js").WikiDelegateReceipt;
  sessionFile?: string;
  /** Durable task execution state not duplicated in the LLM-visible receipt. */
  execution?: WikiAgentExecution;
}

export interface WikiActivityPage {
  entries: WikiActivityEntry[];
  nextBefore?: number;
}

export interface WikiRunView {
  id: string;
  cwd: string;
  operation: WikiProducerOperation;
  focus?: string;
  status: WikiRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastEventSequence: number;
  error?: string;
  pause?: WikiRunPause;
  progress?: WikiRunProgress;
}

export interface WikiProducerResult {
  runId: string;
  status: "succeeded";
  pages: string[];
  sourceFingerprint: string;
  summary: string;
}

export interface WikiRunPause {
  reason: "quota" | "usage_limit";
  summary: string;
  retryAt?: string;
}

export interface WikiRunHandle {
  readonly id: string;
  view(): Promise<WikiRunView>;
  events(after?: number, signal?: AbortSignal): AsyncIterable<WikiRunEvent>;
  result(): Promise<WikiProducerResult>;
  control(action: WikiRunControl): Promise<WikiRunView>;
  inspectAgent(target: WikiAgentTarget): Promise<WikiAgentInspection | undefined>;
  activity(options?: { before?: number; limit?: number; actor?: WikiAgentTarget; severity?: WikiActivityEntry["severity"] }): Promise<WikiActivityPage>;
}

export interface WikiRunAdapterContext {
  runId: string;
  cwd: string;
  operation: WikiProducerOperation;
  focus?: string;
  signal: AbortSignal;
  /** Fresh creates a candidate; resume must preserve the existing candidate. */
  preparation: "fresh" | "resume";
}

export interface WikiPreparedRun {
  inspection: unknown;
  /** Source state pinned by the first preparation and checked on every resume. */
  sourceFingerprint: string;
  candidateWikiRoot: string;
  /** Materialized production skill; readable by Lead and delegated Agents. */
  skillRoot: string;
  sourceScopeIds: string[];
  language: "zh" | "en";
  generation: WikiGenerationProfile;
  /** Last published topology supplied to incremental planning. */
  priorWikiSpec?: WikiSpec;
  maxConcurrentAgents: number;
  budgets: WikiExecutionBudgets;
  /** Stable role selections; the production Pi adapter resolves them to provider models. */
  models: WikiRoleModelConfig;
  taskRuntimeState: WikiTaskRuntimeState;
  runSessionDirectory: string;
  leadSessionFile?: string;
  leadSessionAttempt?: number;
  transientRetries: number;
  /** Per-session wall-clock deadline, converted from workspace seconds. */
  sessionTimeoutMs: number;
  baseRetryDelayMs: number;
  prompt: string;
}

export interface WikiLeadExecutionRequest extends WikiRunAdapterContext, WikiPreparedRun {
  attempt: number;
  report(message: string, data?: Record<string, unknown>): Promise<void>;
  reportObservability(input: { target: WikiAgentTarget; status: "degraded" | "healthy"; at: string; message?: string }): Promise<void>;
  persistTaskRuntimeState(state: WikiTaskRuntimeState): Promise<void>;
}

export type WikiLeadOutcome =
  | { kind: "complete"; summary: string }
  | { kind: "pause"; reason: WikiRunPause["reason"]; summary: string; retryAt?: string };

/** Run-scoped model port. Production creates it with pinned scopes/artifacts/candidate. */
export interface WikiLeadRuntime {
  run(request: WikiLeadExecutionRequest): Promise<WikiLeadOutcome>;
}

/** @internal Production composition seam; callers use createProductionWikiProducer. */
export interface WikiProducerAdapters {
  prepare(input: WikiRunAdapterContext): Promise<WikiPreparedRun>;
  createLead(input: WikiRunAdapterContext & WikiPreparedRun): WikiLeadRuntime | Promise<WikiLeadRuntime>;
  /** Deterministically validate the candidate directory; no model-authored spec input. */
  validate(input: WikiRunAdapterContext & WikiPreparedRun & {
    leadOutcome: WikiLeadOutcome;
  }): Promise<unknown>;
  publish(input: WikiRunAdapterContext & WikiPreparedRun & {
    leadOutcome: WikiLeadOutcome;
    validation: unknown;
  }): Promise<{ pages: string[]; sourceFingerprint: string }>;
}

/** @internal Production composition options. */
export interface WikiProducerOptions {
  adapters: WikiProducerAdapters;
  now?: () => Date;
  createId?: () => string;
  /** Override only for isolated tests. Defaults to `<cwd>/.okf-wiki`. */
  ledgerRoot?: (cwd: string) => string;
}

export class WikiRunResultError extends Error {
  constructor(
    readonly runId: string,
    readonly status: Extract<WikiRunStatus, "failed" | "cancelled">,
    message: string,
  ) {
    super(message);
    this.name = "WikiRunResultError";
  }
}
