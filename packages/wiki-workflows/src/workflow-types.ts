import type { WikiInspection, WikiMode, WikiValidation } from "./types.js";
import type { WikiArtifactRef, WikiArtifactStore } from "./artifact-store.js";

export type { WikiMode } from "./types.js";

/** A durable, Wiki-domain node type. It deliberately does not model generic workflows. */
export type WikiNodeKind =
  | "inspect"
  | "research"
  | "synthesis"
  | "write"
  | "validate"
  | "review"
  | "repair";

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
  /** Present when the model ended without the required control-flow submission. */
  requiredSubmissionTool?: "wiki_submit_synthesis" | "wiki_submit_review";
}

export interface WikiNodeAttempt {
  attempt: number;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown;
  output?: string;
  history?: WikiNodeHistoryEntry[];
  handoff?: WikiArtifactRef;
  error?: WikiNodeError;
  metrics: WikiNodeMetrics;
}

/** A compact, durable record of the subagent activity shown in the run console. */
export type WikiNodeHistoryKind = "message" | "tool_call" | "tool_result" | "error";

export interface WikiNodeHistoryEntry {
  at: string;
  kind: WikiNodeHistoryKind;
  text: string;
  toolName?: string;
  /** Pi's stable call correlation id, retained for compact result rendering. */
  toolCallId?: string;
  /** File or directory target supplied to a file-oriented tool. */
  target?: string;
  /** Small display-oriented description; raw payload remains in text. */
  summary?: string;
  isError?: boolean;
}

export interface WikiNode {
  id: string;
  kind: WikiNodeKind;
  label: string;
  /** Stable execution group. Legacy snapshots omit this and are grouped by kind. */
  phaseId?: string;
  phaseTitle?: string;
  status: WikiNodeStatus;
  dependsOn: string[];
  attempt: number;
  inputFingerprint: string;
  input: unknown;
  result?: unknown;
  output?: string;
  history?: WikiNodeHistoryEntry[];
  /** Immutable, content-addressed handoff produced by this node attempt. */
  handoff?: WikiArtifactRef;
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
  | "phase_retried"
  | "run_forked"
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
  version: 4;
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
  /** The immutable terminal run from which this retry branch was created. */
  parentRunId?: string;
  forkedFromNodeId?: string;
  forkedFromPhaseId?: string;
  forkedAt?: string;
}

/** Lightweight record used by the Navigator's historical run list. */
export interface WikiRunSummary {
  id: string;
  cwd: string;
  requestedMode: WikiMode;
  effectiveMode?: WikiMode;
  focus?: string;
  status: WikiRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  parentRunId?: string;
  head?: string;
  changedPaths: number;
  totalNodes: number;
  succeededNodes: number;
  failedNodes: number;
}

/** Serializable payload stored by the extension as a Pi custom entry. */
export interface WikiRunSession {
  customType: "okf-wiki-run";
  workspace: string;
  snapshot: WikiRunSnapshot;
}

export interface WikiResearchScope {
  id: string;
  /** The declared source roots this bounded investigation may inspect. */
  sourcePaths: string[];
  task: string;
}

export type WikiDiagramKind = "flowchart" | "sequence" | "state" | "er" | "class";

export interface WikiDiagramRequirement {
  kind: WikiDiagramKind;
  applicability: "required" | "not_applicable";
  purpose: string;
  /** Required when a diagram is intentionally omitted. */
  reason?: string;
}

export interface WikiSpecPage {
  pageType: "overview" | "architecture" | "module" | "flow" | "concept";
  path: string;
  title: string;
  purpose: string;
  sources: string[];
  requiredSections: string[];
  diagrams: WikiDiagramRequirement[];
}

export interface WikiDomain {
  id: string;
  title: string;
  purpose: string;
  pages: WikiSpecPage[];
  /** Receipts selected by synthesis for this writer's bounded context. */
  researchScopeIds: string[];
}

export interface WikiCrossLink {
  fromPath: string;
  toPath: string;
  purpose: string;
}

export interface WikiSharedTerm {
  term: string;
  definition: string;
}

/** Immutable writing contract emitted only when source research is sufficient. */
export interface WikiSpec {
  domains: WikiDomain[];
  crossLinks: WikiCrossLink[];
  sharedTerms: WikiSharedTerm[];
}

export interface WikiSynthesisExpandResult {
  decision: "expand";
  researchScopes: WikiResearchScope[];
  rationale: string;
}

export interface WikiSynthesisFinalizeResult {
  decision: "finalize";
  spec: WikiSpec;
  rationale: string;
}

export type WikiSynthesisResult = WikiSynthesisExpandResult | WikiSynthesisFinalizeResult;

/** Metadata-only pointer to a source-grounded research handoff. */
export interface WikiResearchReceipt {
  scopeId: string;
  task: string;
  sourceFingerprint: string;
  artifact: WikiArtifactRef;
}

export type WikiReviewDefectKind = "evidence" | "link" | "format" | "topology" | "coverage" | "depth" | "diagram";

export interface WikiReviewDefect {
  id: string;
  domainId: string;
  page: string;
  kind: WikiReviewDefectKind;
  detail: string;
}

export interface WikiReviewResult {
  defects: WikiReviewDefect[];
  summary: string;
}

export type WikiControlSubmission = WikiSynthesisResult | WikiReviewResult;

export interface WikiAgentExecutionRequest {
  runId: string;
  node: Readonly<WikiNode>;
  cwd: string;
  prompt: string;
  role: "researcher" | "synthesizer" | "writer" | "reviewer";
  /** Declared source roots this agent may inspect. */
  readRoots?: string[];
  /** Exact workspace-local handoff files this agent may read. */
  artifactPaths?: string[];
  /** Exact Wiki files a reviewer may inspect without write permission. */
  reviewPaths?: string[];
  /** Exact workspace-local handoff file a non-writer agent must produce. */
  artifactWritePath?: string;
  /** Exact Wiki-relative files a domain writer may create or change. */
  writePaths?: string[];
  language: "zh" | "en";
  signal: AbortSignal;
  onActivity?: (activity: Partial<WikiNodeActivity>, metrics?: Partial<WikiNodeMetrics>) => void;
  /** A bounded live assistant-text snapshot for the Navigator detail pane. */
  onOutput?: (output: string) => void;
  /** A bounded transcript of completed assistant messages and tool calls. */
  onHistory?: (history: WikiNodeHistoryEntry[]) => void;
  /**
   * Checks a parsed control submission against facts from this run before the
   * submit tool records it. This ephemeral callback is never persisted or
   * exposed in the model-facing JSON schema.
   */
  validateControlSubmission?: (submission: WikiControlSubmission) => void;
}

export interface WikiAgentExecutionResult {
  result: unknown;
  output?: string;
  history?: WikiNodeHistoryEntry[];
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
  /** Workspace-local durable handoffs. Tests can inject an isolated store. */
  artifactStore?: WikiArtifactStore;
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
