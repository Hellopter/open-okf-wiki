import type { WikiInspection, WikiMode, WikiValidation } from "./types.js";

export type { WikiMode } from "./types.js";

/** A durable, Wiki-domain node type. It deliberately does not model generic workflows. */
export type WikiNodeKind =
  | "inspect"
  | "plan"
  | "research"
  | "write"
  | "validate"
  | "review"
  | "repair"
  | "replan";

export type WikiNodeStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "invalidated"
  | "cancelled"
  | "blocked";

export type WikiRunStatus = "running" | "paused" | "succeeded" | "failed" | "blocked" | "cancelled";

export type WikiNodeActivityState = "idle" | "running" | "compacting" | "retrying" | "waiting" | "completed";

export interface WikiNodeActivity {
  state: WikiNodeActivityState;
  message?: string;
  updatedAt: string;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
}

/** Provider-reported figures are exact; context figures can be estimated by Pi. */
export interface WikiNodeMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
  contextEstimated?: boolean;
  compactions: number;
  autoRetries: number;
}

export interface WikiNodeError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface WikiNodeAttempt {
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  output?: string;
  error?: WikiNodeError;
  metrics: WikiNodeMetrics;
}

export interface WikiNode {
  id: string;
  kind: WikiNodeKind;
  label: string;
  status: WikiNodeStatus;
  dependsOn: string[];
  attempt: number;
  inputFingerprint: string;
  input: unknown;
  result?: unknown;
  output?: string;
  error?: WikiNodeError;
  attemptHistory: WikiNodeAttempt[];
  metrics: WikiNodeMetrics;
  activity: WikiNodeActivity;
  startedAt?: string;
  finishedAt?: string;
}

export type WikiRunEventKind =
  | "run_started"
  | "run_paused"
  | "run_resumed"
  | "run_cancelled"
  | "run_completed"
  | "run_blocked"
  | "node_queued"
  | "node_started"
  | "node_activity"
  | "node_succeeded"
  | "node_failed"
  | "node_invalidated"
  | "node_cancelled"
  | "node_retried"
  | "recovered";

export interface WikiRunEvent {
  id: string;
  at: string;
  kind: WikiRunEventKind;
  nodeId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface WikiRunRequest {
  cwd: string;
  mode: WikiMode;
  language?: "zh" | "en";
  focus?: string;
}

export interface WikiRunSnapshot {
  version: 1;
  id: string;
  cwd: string;
  requestedMode: WikiMode;
  effectiveMode?: WikiMode;
  language: "zh" | "en";
  focus?: string;
  status: WikiRunStatus;
  round: number;
  inspection?: WikiInspection;
  inspectionFingerprint?: string;
  nodes: WikiNode[];
  events: WikiRunEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedReason?: string;
}

/** Serializable payload stored by the extension as a Pi custom entry. */
export interface WikiRunSession {
  customType: "okf-wiki-run";
  workspace: string;
  snapshot: WikiRunSnapshot;
}

export interface WikiPlanPage {
  path: string;
  title: string;
  purpose: string;
  sources: string[];
}

export interface WikiResearchScope {
  id: string;
  task: string;
}

export interface WikiPlanResult {
  pages: WikiPlanPage[];
  researchScopes: WikiResearchScope[];
  rationale: string;
}

export interface WikiWriteResult {
  updatedPages: string[];
  deletedPages: string[];
  notes: string[];
}

export type WikiReviewDefectKind = "evidence" | "link" | "format" | "topology" | "coverage";

export interface WikiReviewDefect {
  id: string;
  page: string;
  kind: WikiReviewDefectKind;
  detail: string;
}

export interface WikiReviewResult {
  defects: WikiReviewDefect[];
  summary: string;
}

export interface WikiAgentExecutionRequest {
  runId: string;
  node: Readonly<WikiNode>;
  cwd: string;
  prompt: string;
  role: "planner" | "researcher" | "writer" | "reviewer";
  language: "zh" | "en";
  signal: AbortSignal;
  /** Return a diagnostic when the final response is not the node's required JSON shape. */
  validateResult?: (value: unknown) => string | undefined;
  onActivity?: (activity: Partial<WikiNodeActivity>, metrics?: Partial<WikiNodeMetrics>) => void;
  /** A bounded live assistant-text snapshot for the Navigator detail pane. */
  onOutput?: (output: string) => void;
}

export interface WikiAgentExecutionResult {
  result: unknown;
  output?: string;
  metrics?: Partial<WikiNodeMetrics>;
}

/** Narrow execution boundary. Tests inject this instead of starting model sessions. */
export interface WikiAgentExecutor {
  execute(request: WikiAgentExecutionRequest): Promise<WikiAgentExecutionResult>;
}

export interface WikiWorkflowDependencies {
  inspect(cwd: string): Promise<WikiInspection>;
  validate(cwd: string): Promise<WikiValidation>;
  executor: WikiAgentExecutor;
  now?: () => Date;
  createId?: () => string;
}

export type WikiWorkflowListener = (snapshot: WikiRunSnapshot, event: WikiRunEvent) => void;

export const EMPTY_NODE_METRICS: WikiNodeMetrics = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  cost: 0,
  compactions: 0,
  autoRetries: 0,
};
