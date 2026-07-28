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
import type { ProduceProgress, ProgressSink } from "../../ports/progress-sink.js";
import type { PublishabilityResult } from "../../produce/publishability.js";

export type ProduceWikiModelHandle = {
  model: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
};

export type ProduceWikiModels = {
  writer?: ProduceWikiModelHandle;
  worker?: ProduceWikiModelHandle;
  /** Primary reviewer (seat 0); kept for backward-compatible resolve. */
  reviewer?: ProduceWikiModelHandle;
  /**
   * Per-council-seat reviewer models (decorrelated profiles when configured).
   * Seat i uses reviewers[i] ?? reviewer.
   */
  reviewers?: ProduceWikiModelHandle[];
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
  /**
   * Tool-edge / test callback. Prefer `progressSink` when injecting a port;
   * produceWiki adapts this via progressSinkFromCallback at composition root.
   */
  onProgress?: (progress: ProduceProgress) => void;
  /**
   * Optional progress port. When set, used as the single fan-out for phases
   * (onProgress is ignored). When omitted, produceWiki wraps onProgress.
   */
  progressSink?: ProgressSink;
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
  /**
   * Single progress fan-out for produce phases.
   * Built at produceWiki / repairWiki composition root from progressSink or onProgress.
   * Phases call progress.emit only — never raw callbacks with different safety rules.
   */
  progress: ProgressSink;
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

/** Shared failed ProduceWikiResult shape (hard-validate, research, …). */
export function failedProduceResult(input: {
  summary: string;
  pages?: string[];
  spec: WikiRunSpec;
  defects?: MergedDefectReport | null;
  publishability: PublishabilityResult;
  layout: RunWorkdirLayoutPaths;
  mode: "fixture" | "live";
  metrics: ProduceMetrics;
}): ProduceWikiResult {
  return {
    status: "failed",
    pages: input.pages ?? input.publishability.pages ?? [],
    summary: input.summary,
    spec: input.spec,
    defects: input.defects ?? null,
    publishability: input.publishability,
    layout: input.layout,
    mode: input.mode,
    metrics: input.metrics,
  };
}
