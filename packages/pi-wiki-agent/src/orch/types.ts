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
  | "bootstrap"
  | "survey"
  | "plan"
  | "write"
  | "review"
  | "repair"
  | "host"
  | "other";

export type WikiPhaseStatus = "pending" | "active" | "done" | "failed" | "skipped";

export type WikiOverallStatus = "idle" | "running" | "paused" | "failed" | "completed" | "cancelled";

/** Only session orchestration is supported (pi-dynamic-workflows removed). */
export type WikiBackend = "session";

export interface WikiAgentLastTool {
  name: string;
  path?: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface WikiAgentView {
  agentId: string;
  label: string;
  role: WikiAgentRole;
  phase: string;
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
  receiptsWritten: number;
  tokens?: number;
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

export interface WikiCoverageView {
  pass: number;
  unitsTotal: number;
  unitsWithReceipt: number;
  missingUnitIds: string[];
  retryUnitIds: string[];
}

export interface WikiProgressSnapshot {
  version: 1;
  domainRunId?: string;
  orchRunId: string;
  workspaceRoot: string;
  workdir?: string;
  mode: string;
  focus?: string;
  backend: WikiBackend;
  overall: WikiOverallStatus;
  currentPhase?: string;
  phases: WikiPhaseView[];
  coverage?: WikiCoverageView;
  agents: WikiAgentView[];
  /** Epoch milliseconds. */
  updatedAt: number;
}

export type WikiEventType =
  | "orch.started"
  | "orch.paused"
  | "orch.resumed"
  | "orch.stopped"
  | "orch.completed"
  | "orch.failed"
  | "phase.started"
  | "phase.completed"
  | "phase.failed"
  | "agent.queued"
  | "agent.started"
  | "agent.tool"
  | "agent.token"
  | "agent.heartbeat"
  | "agent.succeeded"
  | "agent.failed"
  | "agent.timed_out"
  | "agent.cancelled"
  | "coverage.updated"
  | "host.tool";

export interface WikiEvent {
  ts: number;
  seq: number;
  type: WikiEventType;
  orchRunId: string;
  domainRunId?: string;
  agentId?: string;
  phase?: string;
  detail?: unknown;
}

export interface OrchLimits {
  concurrency: number;
  maxAgents: number;
  agentTimeoutMs: number;
  agentRetries: number;
  maxSurveyLanes: number;
  targetUnitsPerLane: number;
  heartbeatMs: number;
  staleWarnMs: number;
}

export const DEFAULT_ORCH_LIMITS: OrchLimits = {
  concurrency: 4,
  maxAgents: 48,
  agentTimeoutMs: 900_000,
  agentRetries: 1,
  maxSurveyLanes: 4,
  targetUnitsPerLane: 3,
  heartbeatMs: 5_000,
  staleWarnMs: 30_000,
};

export function mergeOrchLimits(partial?: Partial<OrchLimits>): OrchLimits {
  return { ...DEFAULT_ORCH_LIMITS, ...partial };
}

export interface OrchRunSummary {
  orchRunId: string;
  domainRunId?: string;
  overall: WikiOverallStatus;
  backend: WikiBackend;
  currentPhase?: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  workspaceRoot: string;
}
