/**
 * Injectable scoped-agent runner for Run Workflow (DIP).
 * Live Pi and fixture adapters implement this; workflow must not import Pi SDK.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { NodeAttempt, WikiRunSpec } from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../pi/run-workdir.js";
import type { SourceIgnoreInput } from "../pi/tool-operations.js";
import type { WikiAgentRole } from "../pi/tool-policy.js";

export type ScopedRunnerRole = Extract<
  WikiAgentRole,
  "domain" | "leaf" | "reviewer" | "root_research" | "plan" | "root_write"
>;

/** Progress from one scoped loop — maps to a NodeAttempt on the Run Graph. */
export type ScopedRunnerProgress = NodeAttempt;

export type AgentRunRequest = {
  role: ScopedRunnerRole;
  runWorkDir: string;
  task: string;
  systemPrompt?: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
  sourceIgnores?: SourceIgnoreInput;
  maxContextTokens?: number;
  contextTargetTokens?: number;
  additionalSkillPaths?: readonly string[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  spanId?: string;
  wikiDir?: string;
  /** Opaque custom tools (plan submit, etc.) — typed loosely to avoid Pi coupling here. */
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
  layout: RunWorkdirLayout;
  spec: WikiRunSpec;
  workspaceName: string;
  model?: Model<any>;
  modelRuntime?: ModelRuntime;
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
  layout: RunWorkdirLayout;
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
