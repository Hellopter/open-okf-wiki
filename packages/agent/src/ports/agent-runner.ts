/**
 * Injectable scoped-agent runner for Run Workflow (DIP).
 *
 * Ports stay free of Pi SDK and runtime/pi modules — only contract types,
 * local string unions, and opaque `unknown` for model/runtime handles.
 * Live/fixture adapters cast to concrete Pi types at the boundary.
 */

import type { NodeAttempt, WikiRunSpec } from "@okf-wiki/contract";

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
  systemPrompt?: string;
  /** Opaque model handle — runtime adapters cast to Pi Model. */
  model?: unknown;
  /** Opaque model runtime — runtime adapters cast to Pi ModelRuntime. */
  modelRuntime?: unknown;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  spanId?: string;
  wikiDir?: string;
  /** Opaque custom tools (plan submit, etc.) — typed loosely to avoid Pi coupling. */
  customTools?: readonly unknown[];
  onProgress?: (attempt: ScopedRunnerProgress) => void;
};

export type AgentRunResult = {
  role: ScopedRunnerRole;
  summary: string;
  mode: "live" | "fixture";
  pages?: string[];
  receiptPath?: string;
  specPath?: string;
};

export type WikiWriteRequest = {
  layout: RunWorkdirLayoutPaths;
  spec: WikiRunSpec;
  workspaceName: string;
  model?: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  sourceIgnores?: SourceIgnoreInput;
  abortSignal?: AbortSignal;
  onProgress?: (attempt: ScopedRunnerProgress) => void;
  systemPrompt?: string;
  task: string;
};

export type WikiWriteResult = {
  mode: "live" | "fixture";
  layout: RunWorkdirLayoutPaths;
  pages: string[];
  summary: string;
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
