/**
 * Injectable scoped-agent runner for Run Workflow (DIP).
 *
 * Ports stay free of Pi SDK and runtime/pi modules — only contract types,
 * local string unions, and opaque `unknown` for model/runtime handles.
 * Live/fixture adapters cast to concrete Pi types at the boundary.
 */

import type {
  AttemptItem,
  AttemptMetrics,
  NodeAttempt,
  RetryLimits,
  WikiRunSpec,
} from "@okf-wiki/contract";

/** Roles that may run through AgentRunner (subset of operator/scoped roles). */
export type ScopedRunnerRole =
  | "domain"
  | "leaf"
  | "reviewer"
  | "root_research"
  | "plan"
  | "root_write";

/** Progress from one scoped loop — maps to a NodeAttempt on the Run Graph. */
export type ScopedRunnerProgress = NodeAttempt;

/**
 * Run workdir layout paths (mirrors runtime layout; no import from pi/).
 * sourceMounts: sourceId → absolute path under sources/.
 */
export type RunWorkdirLayoutPaths = {
  runWorkDir: string;
  sourcesDir: string;
  skillDir: string;
  wikiDir: string;
  analysisDir: string;
  sourceMounts: Map<string, string>;
};

/**
 * Effective source ignore patterns for FS tool wrappers.
 * Map form: sourceId → patterns; array form: flat patterns.
 */
export type SourceIgnoreInput = ReadonlyMap<string, readonly string[]> | readonly string[];

export type AgentRunRequest = {
  role: ScopedRunnerRole;
  runWorkDir: string;
  task: string;
  /**
   * Role system prompt. Live adapters throw if omitted — no runtime defaults.
   * Fixture adapters may ignore it.
   */
  systemPrompt?: string;
  /**
   * Prefer last assistant message over streamed text for the control summary.
   * Plan and reviewer phases must pass true; research/scouts typically false.
   */
  preferFinalMessage: boolean;
  /** Opaque model handle — runtime adapters cast to Pi Model. */
  model?: unknown;
  /** Opaque model runtime — runtime adapters cast to Pi ModelRuntime. */
  modelRuntime?: unknown;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  /** Pi auto-retry policy (workspace.limits.retry). Live adapter injects into session settings. */
  retry?: RetryLimits;
  additionalSkillPaths?: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Unique attempt id for this scoped loop (streaming upserts share the same id).
   * Defaults to role when omitted. Prefer topology-aligned ids (`plan`, `domain-x`,
   * `review@0:reviewer-1`) so multi-round work appends rather than orphans.
   */
  spanId?: string;
  /**
   * Topology node this attempt belongs to. Defaults to spanId/role when omitted.
   * Review council members share `review`; only attemptId differs per member/round.
   */
  nodeKey?: string;
  /** Round / retry index for the topology node (0-based). Defaults to 0. */
  runIndex?: number;
  /** Opaque custom tools (plan submit, etc.) — typed loosely to avoid Pi coupling. */
  customTools?: readonly unknown[];
  onProgress?: (attempt: ScopedRunnerProgress) => void;
  /**
   * Attempt session.jsonl path for secret-free conversation/tool projection.
   * Live/fixture adapters write JSONL here for Node details transcript API.
   */
  transcriptPath?: string;
};

export type AgentRunResult = {
  role: ScopedRunnerRole;
  summary: string;
  mode: "live" | "fixture";
  receiptPath?: string;
  /** Final tool/text trail when the runner projected one. */
  items?: AttemptItem[];
  /**
   * Best-effort observation metrics from the live projector (tokens / toolCalls).
   * Missing fields never block completion; fixture runs typically omit this.
   */
  metrics?: AttemptMetrics;
  /**
   * Per-task settle marker for runAgentsParallel: true when this task failed
   * (summary carries the error). Sibling results are still returned; only
   * AbortError rejects the whole batch.
   */
  failed?: boolean;
};

export type WikiWriteRequest = {
  layout: RunWorkdirLayoutPaths;
  spec: WikiRunSpec;
  workspaceName: string;
  model?: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  /** Pi auto-retry policy (workspace.limits.retry). Live adapter injects into session settings. */
  retry?: RetryLimits;
  additionalSkillPaths?: readonly string[];
  sourceIgnores?: SourceIgnoreInput;
  abortSignal?: AbortSignal;
  /** Wall-clock budget for the write session (workspace limits). */
  timeoutMs?: number;
  onProgress?: (attempt: ScopedRunnerProgress) => void;
  systemPrompt?: string;
  task: string;
  /**
   * Unique attempt id for this write (defaults to `root_write`).
   * Repair rounds should use `repair@{runIndex}` so history appends.
   */
  spanId?: string;
  /**
   * Topology node for the attempt (defaults to spanId / `root_write`).
   * Initial produce write → `root_write`; repair loop → `repair`.
   */
  nodeKey?: string;
  /** Round / retry index for the topology node (0-based). Defaults to 0. */
  runIndex?: number;
  /**
   * Graph attempt role. Session always uses root_write tools; progress may
   * report `repair` so the Run Graph attaches to the repair topology node.
   */
  graphRole?: "root_write" | "repair";
  /**
   * Attempt session.jsonl path for secret-free conversation/tool projection.
   */
  transcriptPath?: string;
};

export type WikiWriteResult = {
  mode: "live" | "fixture";
  layout: RunWorkdirLayoutPaths;
  pages: string[];
  summary: string;
  /** Final tool/text trail when the runner projected one. */
  items?: AttemptItem[];
  /** Best-effort observation metrics from the live writer session. */
  metrics?: AttemptMetrics;
};

/**
 * Produce orchestration depends on this port — not on concrete Pi session helpers.
 */
export interface AgentRunner {
  readonly kind: "live" | "fixture";
  runAgent(input: AgentRunRequest): Promise<AgentRunResult>;
  runAgentsParallel(
    tasks: AgentRunRequest[],
    opts?: { concurrency?: number },
  ): Promise<AgentRunResult[]>;
  writeWiki(input: WikiWriteRequest): Promise<WikiWriteResult>;
}
