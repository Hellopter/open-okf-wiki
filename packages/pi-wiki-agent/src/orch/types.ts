/**
 * Orchestration view models, event types, and run limits for multi-agent Wiki runs.
 *
 * Durable state is owned by WikiRunStore (snapshot + event log). These types are
 * the shared contract between the orchestrator, progress scanner, and any UI.
 */

export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_tool"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped";

export type WikiAgentRole =
  | "main"
  | "source-researcher"
  | "integration-researcher"
  | "evidence-researcher"
  | "coverage-critic"
  | "reviewer-evidence"
  | "reviewer-workflow"
  | "reviewer-navigation"
  | "qa-question-finder"
  | "qa-answer-verifier";

export type WikiPhaseStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type WikiOverallStatus = "idle" | "running" | "paused" | "proposed" | "quality_blocked" | "failed" | "completed" | "cancelled";

/** Only session orchestration is supported (pi-dynamic-workflows removed). */
export type WikiBackend = "session";

export interface WikiAgentLastTool {
  name: string;
  path?: string;
  /** Epoch milliseconds. */
  at: number;
}

/** Provider-reported token usage for one completion or an accumulated agent run. */
export interface WikiTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Estimated context currently held by a Pi session. */
export interface WikiContextUsage {
  tokens: number;
  contextWindow?: number;
  /** Rounded percent of the model context window when it is known. */
  percent?: number;
}

export type WikiAgentActivityKind = "retrying" | "compacting";

/** A transient Pi session operation that should remain visible without changing lifecycle status. */
export interface WikiAgentActivity {
  kind: WikiAgentActivityKind;
  /** Epoch milliseconds. */
  at: number;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  reason?: "manual" | "threshold" | "overflow";
  message?: string;
}

export type WikiObservationRole = "assistant" | "tool" | "system";

export type WikiObservationKind =
  | "text"
  | "tool_start"
  | "tool_end"
  | "retry_start"
  | "retry_end"
  | "compaction_start"
  | "compaction_end"
  | "summarization_retry";

/**
 * A display-safe, durable execution observation. Tool arguments/results are reduced
 * to paths, search terms, and short error messages before they reach transcript.jsonl.
 */
export interface WikiObservationEntry {
  role: WikiObservationRole;
  kind: WikiObservationKind;
  /** Epoch milliseconds. */
  timestamp: number;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  path?: string;
  query?: string;
  isError?: boolean;
  error?: string;
  usage?: WikiTokenUsage;
  context?: WikiContextUsage;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  success?: boolean;
  reason?: "manual" | "threshold" | "overflow";
  tokensBefore?: number;
  tokensAfter?: number;
  aborted?: boolean;
}

export interface WikiAgentView {
  agentId: string;
  label: string;
  role: WikiAgentRole;
  phase: string;
  /** Original task prompt, retained so the run workbench can explain intent. */
  prompt?: string;
  status: AgentStatus;
  unitIds?: string[];
  pagePaths?: string[];
  model?: string;
  /** Epoch milliseconds. */
  startedAt?: number;
  /** Epoch milliseconds. */
  endedAt?: number;
  elapsedMs: number;
  lastTool?: WikiAgentLastTool;
  /** Epoch milliseconds. */
  lastHeartbeatAt?: number;
  lastError?: string;
  /** Cumulative usage across model turns and compaction summaries. */
  tokenUsage?: WikiTokenUsage;
  /** Provider usage from the latest model turn. */
  latestUsage?: WikiTokenUsage;
  /** Current estimated session context, not cumulative spend. */
  context?: WikiContextUsage;
  /** Present only while Pi is retrying a turn or compacting context. */
  activity?: WikiAgentActivity;
  compactionCount?: number;
  transcriptPath?: string;
  sessionKey?: string;
}

export interface WikiPhaseView {
  name: string;
  status: WikiPhaseStatus;
  /** Epoch milliseconds. */
  startedAt?: number;
  /** Epoch milliseconds. */
  endedAt?: number;
  summary?: string;
}

/** Aggregated result of the bounded coverage and bundle-quality gates. */
export interface WikiQualitySummary {
  verdict?: "pending" | "passed" | "failed" | "blocked";
  passed?: number;
  failed?: number;
  blocked?: number;
  findings?: number;
}

export interface WikiProgressSnapshot {
  version: 1;
  runId: string;
  orchRunId: string;
  workspaceRoot: string;
  mode: string;
  focus?: string;
  backend: WikiBackend;
  overall: WikiOverallStatus;
  currentPhase?: string;
  phases: WikiPhaseView[];
  agents: WikiAgentView[];
  /** Full Markdown proposal for the approval workbench; only set after coverage passes. */
  planPreview?: string;
  planSummary?: string;
  qualitySummary?: WikiQualitySummary;
  /** Epoch milliseconds. */
  updatedAt: number;
}

export type WikiEventType =
  | "orch.started"
  | "orch.paused"
  | "orch.resumed"
  | "orch.stopped"
  | "orch.completed"
  | "orch.proposed"
  | "orch.failed"
  | "orch.quality_blocked"
  | "phase.started"
  | "phase.completed"
  | "phase.failed"
  | "agent.queued"
  | "agent.started"
  | "agent.tool"
  | "agent.token"
  | "agent.retry"
  | "agent.compaction"
  | "agent.heartbeat"
  | "agent.succeeded"
  | "agent.failed"
  | "agent.timed_out"
  | "agent.cancelled"
  | "host.tool";

export interface WikiEvent {
  ts: number;
  seq: number;
  type: WikiEventType;
  orchRunId: string;
  runId?: string;
  agentId?: string;
  phase?: string;
  detail?: unknown;
}

export interface OrchLimits {
  concurrency: number;
  maxAgents: number;
  agentTimeoutMs: number;
  heartbeatMs: number;
  staleWarnMs: number;
}

export const DEFAULT_ORCH_LIMITS: OrchLimits = {
  concurrency: 4,
  maxAgents: 48,
  agentTimeoutMs: 900_000,
  heartbeatMs: 5_000,
  staleWarnMs: 30_000,
};

export function mergeOrchLimits(partial?: Partial<OrchLimits>): OrchLimits {
  return { ...DEFAULT_ORCH_LIMITS, ...partial };
}

export interface OrchRunSummary {
  orchRunId: string;
  runId?: string;
  overall: WikiOverallStatus;
  backend: WikiBackend;
  currentPhase?: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  workspaceRoot: string;
}
