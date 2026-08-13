export type WikiProducerOperation = "update" | "regenerate";

export type WikiRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type WikiRunControl = "pause" | "resume" | "cancel";

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

export type WikiRunStage = "prepare" | "lead" | "delegate" | "validate" | "publish";

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
  summary?: string;
  attempts?: number;
  attempt?: number;
  startedAt?: string;
  updatedAt?: string;
  sampledAt?: string;
  activity?: WikiTaskActivity;
  activeTool?: WikiActiveTool;
  contextRecalculating?: boolean;
  usage?: WikiContextStats;
}

export type WikiTaskActivity = "responding" | "tool" | "idle" | "compacting";

export interface WikiActiveTool {
  name: string;
  startedAt: string;
}

/** Runtime checkpoint emitted by a delegated Pi session. */
export interface WikiTaskTelemetry {
  taskId: string;
  attempt: number;
  sampledAt: string;
  activity?: WikiTaskActivity;
  activeTool?: WikiActiveTool;
  contextRecalculating?: boolean;
  usage?: WikiContextStats;
  history?: WikiHistoryEntry[];
}

export interface WikiRunProgress {
  stage: WikiRunStage;
  batch?: number;
  completed?: number;
  total?: number;
  tasks?: WikiTaskSnapshot[];
  lastMessage?: string;
}

export interface WikiHistoryEntry {
  role: "user" | "assistant" | "tool";
  kind: "text" | "toolCall" | "toolResult" | "error";
  text: string;
  toolName?: string;
  path?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface WikiTaskInspection {
  runId: string;
  task: WikiTaskSnapshot;
  receipt?: import("./delegate-contracts.js").WikiDelegateReceipt;
  handoff?: string;
  handoffPath?: string;
  history?: WikiHistoryEntry[];
  usage?: WikiContextStats;
  processAvailable: boolean;
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
  inspect(taskId: string): Promise<WikiTaskInspection | undefined>;
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
  sourceScopeIds: string[];
  language: "zh" | "en";
  maxConcurrentAgents: number;
  transientRetries: number;
  baseRetryDelayMs: number;
  prompt: string;
}

export interface WikiLeadExecutionRequest extends WikiRunAdapterContext, WikiPreparedRun {
  attempt: number;
  report(message: string, data?: Record<string, unknown>): Promise<void>;
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
