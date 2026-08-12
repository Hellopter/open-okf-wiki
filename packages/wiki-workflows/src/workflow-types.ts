import type { WikiNodeErrorCode } from "./failures.js";
import type { WikiFinalization, WikiInspection, WikiMode, WikiValidation, WikiValidationIssue } from "./types.js";
import type { WikiArtifactRef, WikiArtifactStore } from "./artifact-store.js";
import type { ResolvedWikiPolicy } from "./policy.js";

export type { WikiMode } from "./types.js";
export type { WikiNodeErrorCode } from "./failures.js";

/** A durable, Wiki-domain node type. It deliberately does not model generic workflows. */
export type WikiNodeKind =
  | "inspect"
  | "research"
  | "synthesis"
  | "write"
  | "validate"
  | "review"
  | "finalize";

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
  /** Pi session auto-retry events (provider/transient); counted via activity deltas. */
  autoRetries: number;
  /** Executor salvage follow-ups for context pressure (0 or 1 per node attempt). */
  salvageAttempts?: number;
  /** Executor correction follow-ups for missing/invalid submission (0 or 1 per node attempt). */
  correctionAttempts?: number;
}

/** Stable failure codes — single source in failures.ts. */
export interface WikiNodeError {
  message: string;
  code?: WikiNodeErrorCode | string;
  retryable?: boolean;
  /** Present when the model ended without the required control-flow submission. */
  requiredSubmissionTool?: "wiki_submit_research" | "wiki_submit_synthesis" | "wiki_submit_page" | "wiki_submit_review";
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
  /** Stable user-visible execution stage. */
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
  | "run_failed"
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
  maxResearchRounds?: number;
  wikiPolicy?: Partial<Omit<ResolvedWikiPolicy, "version" | "promptBundleHash">>;
}

export interface WikiRunSnapshot {
  version: 10;
  id: string;
  cwd: string;
  requestedMode: WikiMode;
  effectiveMode?: WikiMode;
  language: "zh" | "en";
  focus?: string;
  status: WikiRunStatus;
  round: number;
  /** Number of automatic restarts caused by source fingerprint drift. */
  sourceRestartCount: number;
  maxResearchRounds: number;
  /** Product defaults and workspace overrides pinned for this complete run. */
  policy: ResolvedWikiPolicy;
  policyHash: string;
  inspection?: WikiInspection;
  inspectionFingerprint?: string;
  nodes: WikiNode[];
  events: WikiRunEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  blockedReason?: string;
  /** Structured diagnostics when the run terminalized as blocked/failed. */
  blockedDetails?: {
    code?: WikiNodeErrorCode | string;
    issues?: WikiValidationIssue[];
    defects?: Array<Record<string, string>>;
    page?: string;
    comparedNodeId?: string;
    /** Budget counters remaining (or exhausted-at) when a budget policy blocked the run. */
    remainingBudget?: Record<string, number>;
  };
  /** The immutable terminal run from which this retry branch was created. */
  parentRunId?: string;
  forkedFromNodeId?: string;
  forkedFromPhaseId?: string;
  forkedAt?: string;
  /** Monotonic checkpoint counter written by persistence (session/history). */
  revision?: number;
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

/**
 * Pointer-only payload stored by the extension as a Pi custom entry.
 * Full run state lives in the project history store keyed by `runId`.
 * Legacy full-snapshot session entries are rejected (fail closed).
 */
export interface WikiRunSession {
  customType: "okf-wiki-run";
  workspace: string;
  pointerVersion: 1;
  runId: string;
  revision: number;
  status: WikiRunStatus;
  updatedAt: string;
}

export interface WikiResearchScope {
  id: string;
  /** The declared source roots this bounded investigation may inspect. */
  sourcePaths: string[];
  task: string;
}

export type WikiResearchFindingKind = "domain" | "concept" | "flow" | "boundary" | "state-data";
export type WikiResearchPriority = "critical" | "normal";

/** Model-authored finding before the engine assigns an evidence-derived ID. */
export interface WikiResearchFindingDraft {
  kind: WikiResearchFindingKind;
  title: string;
  readerQuestion: string;
  priority: WikiResearchPriority;
  evidence: string[];
}

export interface WikiResearchFinding extends WikiResearchFindingDraft {
  id: string;
  scopeId: string;
}

export interface WikiResearchGap {
  question: string;
  priority: WikiResearchPriority;
  sourcePaths: string[];
}

export interface WikiResearchArtifact {
  summary: string;
  findings: WikiResearchFindingDraft[];
  gaps: WikiResearchGap[];
}

export interface WikiSpecPage {
  pageType: "overview" | "domain" | "architecture" | "module" | "flow" | "concept" | "state" | "data";
  path: string;
  title: string;
  purpose: string;
  /** Questions this page must answer independently for its intended reader. */
  readerQuestions: string[];
  /** Source-grounded aspects that writing and semantic review must cover. */
  requiredFacets: string[];
  /** Evidence findings selected specifically for this page. Empty only for Overview. */
  findingIds: string[];
}

export interface WikiDomain {
  id: string;
  title: string;
  purpose: string;
  pages: WikiSpecPage[];
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

export interface WikiOmission {
  findingId: string;
  rationale: string;
}

/** Immutable writing contract emitted only when source research is sufficient. */
export interface WikiSpec {
  domains: WikiDomain[];
  crossLinks: WikiCrossLink[];
  sharedTerms: WikiSharedTerm[];
  omissions: WikiOmission[];
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
  findings: Array<{
    id: string;
    priority: WikiResearchPriority;
    /** kind+title+paths fingerprint; used for dry-audit sameness across scopes. */
    contentFingerprint: string;
  }>;
  criticalGapSignatures: string[];
  /** Critical gap questions (for expand-scope binding); parallel to signatures. */
  criticalGapQuestions: string[];
}

export type WikiLocalReviewDefectKind = "evidence" | "link" | "depth" | "diagram";
export type WikiStructuralReviewDefectKind = "topology" | "coverage";
export type WikiReviewDefectKind = WikiLocalReviewDefectKind | WikiStructuralReviewDefectKind;

export interface WikiLocalReviewDefect {
  kind: WikiLocalReviewDefectKind;
  page: string;
  detail: string;
}

export interface WikiStructuralReviewDefect {
  kind: WikiStructuralReviewDefectKind;
  detail: string;
}

export type WikiReviewDefect = WikiLocalReviewDefect | WikiStructuralReviewDefect;

export interface WikiReviewResult {
  defects: WikiReviewDefect[];
  summary: string;
}

export type WikiControlSubmission = WikiResearchArtifact | WikiSynthesisResult | WikiReviewResult;

export interface WikiPageSubmission {
  page: string;
  sha256: string;
}

export interface WikiPageValidationFailure {
  code: string;
  message: string;
}

export type WikiPageSubmissionResult =
  | { ok: true; submission: WikiPageSubmission }
  | { ok: false; issues: WikiPageValidationFailure[] };

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
  /** Exact Wiki files this agent may inspect without write permission. */
  wikiReadPaths?: string[];
  /** Internal persistence target for accepted control output; never model-authored. */
  /** Unpublished Wiki root used for exact writer and reviewer paths in this run. */
  candidateWikiRoot?: string;
  /** Exact Wiki-relative files a page writer may create or change. */
  writePaths?: string[];
  language: "zh" | "en";
  signal: AbortSignal;
  /** Pinned per-node direct structured submission budget. */
  maxSubmissionAttempts?: number;
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
  /** Validate and seal the writer's assigned page without ending its session on failure. */
  validatePageSubmission?: (page: string) => Promise<WikiPageSubmissionResult>;
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
  /** Align the executor admission gate with the policy pinned for the active run. */
  setMaxConcurrentAgents?(value: number): void;
  /** Apply runtime values pinned into the active run snapshot. */
  setRuntimePolicy?(policy: Pick<ResolvedWikiPolicy, "quality" | "runtime">): void;
}

export interface WikiWorkflowDependencies {
  inspect(cwd: string, policy?: ResolvedWikiPolicy): Promise<WikiInspection>;
  validate(cwd: string, spec: WikiSpec, wikiDirectory?: string, excludedPaths?: readonly string[]): Promise<WikiValidation>;
  validatePage(cwd: string, spec: WikiSpec, page: string, wikiDirectory?: string, excludedPaths?: readonly string[]): Promise<WikiPageValidationFailure[]>;
  materializeIndexes(cwd: string, spec: WikiSpec, wikiDirectory?: string): Promise<string[]>;
  finalize(cwd: string, spec: WikiSpec, wikiDirectory?: string, publicationAt?: string): Promise<WikiFinalization>;
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
