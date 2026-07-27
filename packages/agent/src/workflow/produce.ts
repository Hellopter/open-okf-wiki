/**
 * Run Workflow produce body: research → write → review/repair → score.
 *
 * Thin sequencer over phases; no Pi SDK, no ToolDefinition.
 * Operator repair (wiki_repair) enters via repairWiki — same write-phase path.
 */

import type { WikiRunSpec, WorkspaceConfig } from "@okf-wiki/contract";
import type {
  AgentRunner,
  RunWorkdirLayoutPaths,
  SourceIgnoreInput,
  WikiWriteResult,
} from "../ports/agent-runner.js";
import { defaultReceiptStore } from "../ports/core-receipt-store.js";
import { emitProgress, type ProduceProgress } from "../ports/progress-sink.js";
import { listWikiMarkdown } from "../produce/wiki-pages.js";
import { resolveOrchestration } from "./budgets.js";
import { runResearchPhase } from "./phases/research-phase.js";
import { runReviewRepairPhase } from "./phases/review-repair-phase.js";
import {
  cancelledResult,
  type PhaseContext,
  type ProduceWikiInput,
  type ProduceWikiModels,
  type ProduceWikiResult,
} from "./phases/types.js";
import { emitPagesFromDisk, runRepairWrite, runWritePhase } from "./phases/write-phase.js";

export type {
  ProduceWikiInput,
  ProduceWikiModels,
  ProduceWikiResult,
} from "./phases/types.js";

/**
 * Layer B Produce: research → write → council → repair → hard score.
 */
export async function produceWiki(input: ProduceWikiInput): Promise<ProduceWikiResult> {
  const onProgress = input.onProgress;
  const orch = resolveOrchestration(input.workspace);
  const runtime = input.runtime;
  const metrics = { domainStarts: 0, leafStarts: 0, repairRounds: 0 };
  const multiSource = (input.workspace.sources?.length ?? 0) > 1;
  const wikiLanguage = input.workspace.wikiLanguage ?? "en";
  const contextTargetTokens =
    input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens;
  const { layout, spec } = input;
  const mode: "fixture" | "live" = runtime.kind;

  if (input.abortSignal?.aborted) {
    return cancelledResult(spec, mode, metrics, layout);
  }

  const ctx: PhaseContext = {
    input,
    onProgress,
    runtime,
    metrics,
    multiSource,
    wikiLanguage,
    contextTargetTokens,
    layout,
    spec,
    mode,
  };

  try {
    // Spec must already be committed by runWiki (defaultSpecStore). Produce only reads it.
    await emitPagesFromDisk(onProgress, layout.wikiDir, spec);

    const research = await runResearchPhase(ctx, orch);
    if (research.kind === "cancelled" || research.kind === "failed") {
      return research.result;
    }

    const write = await runWritePhase(ctx);
    if (write.kind === "cancelled") {
      return write.result;
    }

    const review = await runReviewRepairPhase(ctx, write.produced, orch);
    return review.result;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return cancelledResult(spec, mode, metrics, layout);
    }
    throw err;
  }
}

/** Input for operator-driven repair on existing Staging Wiki (wiki_repair). */
export type RepairWikiInput = {
  runId: string;
  workspace: WorkspaceConfig;
  layout: RunWorkdirLayoutPaths;
  spec: WikiRunSpec;
  runtime: AgentRunner;
  models?: ProduceWikiModels;
  /** Operator defect notes / repair focus. */
  defectNotes: string;
  abortSignal?: AbortSignal;
  additionalSkillPaths?: readonly string[];
  maxContextTokens?: number;
  contextTargetTokens?: number;
  onProgress?: (progress: ProduceProgress) => void;
  sourceIgnores?: SourceIgnoreInput;
};

export type RepairWikiResult = {
  status: "repaired" | "cancelled";
  pages: string[];
  summary: string;
  layout: RunWorkdirLayoutPaths;
  mode: "fixture" | "live";
};

/**
 * Operator repair entry: root_write with repair defects via write-phase.
 * Tools must call this rather than AgentRunner.writeWiki directly.
 */
export async function repairWiki(input: RepairWikiInput): Promise<RepairWikiResult> {
  const multiSource = (input.workspace.sources?.length ?? 0) > 1;
  const wikiLanguage = input.workspace.wikiLanguage ?? "en";
  const contextTargetTokens =
    input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens;
  const mode: "fixture" | "live" = input.runtime.kind;
  const metrics = { domainStarts: 0, leafStarts: 0, repairRounds: 1 };

  const produceInput: ProduceWikiInput = {
    runId: input.runId,
    workspace: input.workspace,
    layout: input.layout,
    spec: input.spec,
    runtime: input.runtime,
    models: input.models,
    abortSignal: input.abortSignal,
    additionalSkillPaths: input.additionalSkillPaths,
    maxContextTokens: input.maxContextTokens,
    contextTargetTokens,
    onProgress: input.onProgress,
    sourceIgnores: input.sourceIgnores,
  };

  const ctx: PhaseContext = {
    input: produceInput,
    onProgress: input.onProgress,
    runtime: input.runtime,
    metrics,
    multiSource,
    wikiLanguage,
    contextTargetTokens,
    layout: input.layout,
    spec: input.spec,
    mode,
  };

  const existingPages = await listWikiMarkdown(input.layout.wikiDir);
  const prior: WikiWriteResult = {
    mode,
    layout: input.layout,
    pages: existingPages,
    summary: "existing staging",
  };

  const receiptIndex = await defaultReceiptStore.buildIndex(input.workspace.rootPath, input.runId);
  emitProgress(input.onProgress, {
    kind: "status",
    status: "producing",
    summary: "root_write repair",
  });

  const result = await runRepairWrite({
    ctx,
    produced: prior,
    defectText: input.defectNotes,
    receiptIndex,
  });

  if (result.kind === "cancelled") {
    return {
      status: "cancelled",
      pages: result.result.pages,
      summary: result.result.summary,
      layout: result.result.layout,
      mode,
    };
  }

  return {
    status: "repaired",
    pages: result.produced.pages,
    summary:
      result.produced.summary || `Repaired Staging Wiki (${result.produced.pages.length} pages)`,
    layout: result.produced.layout,
    mode: result.produced.mode,
  };
}

