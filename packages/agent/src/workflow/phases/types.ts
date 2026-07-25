/**
 * Shared context for Run Workflow produce phases.
 * Ports only — no Pi SDK.
 */

import type { MergedDefectReport, WikiRunSpec, WorkspaceConfig } from "@okf-wiki/contract";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
} from "../../ports/agent-runner.js";
import type { ProduceProgress } from "../../ports/progress-sink.js";
import type { PublishabilityResult } from "../../produce/publishability.js";

export type ProduceWikiModels = {
  writer?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
  worker?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
  reviewer?: {
    model: unknown;
    modelRuntime?: unknown;
    maxContextTokens?: number;
  };
};

export type ProduceWikiInput = {
  runId: string;
  workspace: WorkspaceConfig;
  layout: RunWorkdirLayoutPaths;
  /** Already-approved and committed living Spec. */
  spec: WikiRunSpec;
  runtime: AgentRunner;
  models?: ProduceWikiModels;
  abortSignal?: AbortSignal;
  additionalSkillPaths?: readonly string[];
  maxContextTokens?: number;
  contextTargetTokens?: number;
  onProgress?: (progress: ProduceProgress) => void;
  sourceIgnores?: SourceIgnoreInput;
};

export type ProduceWikiResult = {
  status: "ready_for_publish" | "failed" | "cancelled";
  pages: string[];
  summary: string;
  spec: WikiRunSpec;
  defects: MergedDefectReport | null;
  publishability: PublishabilityResult;
  layout: RunWorkdirLayoutPaths;
  mode: "fixture" | "live";
  metrics: {
    domainStarts: number;
    leafStarts: number;
    repairRounds: number;
  };
};

export type ProduceMetrics = ProduceWikiResult["metrics"];

export type PhaseContext = {
  input: ProduceWikiInput;
  onProgress: ProduceWikiInput["onProgress"];
  runtime: AgentRunner;
  metrics: ProduceMetrics;
  multiSource: boolean;
  wikiLanguage: "en" | "zh";
  contextTargetTokens: number | undefined;
  layout: RunWorkdirLayoutPaths;
  spec: WikiRunSpec;
  mode: "fixture" | "live";
};

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Wiki Run cancelled");
    err.name = "AbortError";
    throw err;
  }
}

export function cancelledResult(
  spec: WikiRunSpec,
  mode: "fixture" | "live",
  metrics: ProduceMetrics,
  layout: RunWorkdirLayoutPaths,
  produced?: { pages: string[]; layout: RunWorkdirLayoutPaths },
): ProduceWikiResult {
  const emptyPub: PublishabilityResult = {
    publishable: false,
    reasons: ["cancelled"],
    pages: produced?.pages ?? [],
    defects: null,
  };
  return {
    status: "cancelled",
    pages: produced?.pages ?? [],
    summary: "Wiki Run cancelled",
    spec,
    defects: null,
    publishability: emptyPub,
    layout: produced?.layout ?? layout,
    mode,
    metrics,
  };
}
