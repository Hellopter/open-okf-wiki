/**
 * Review council + bounded repair loop (Run Workflow phase / T2).
 *
 * Repair budget (`maxRepairRounds`) is shared by:
 * 1. Review-council blocking defects
 * 2. Mechanical hard-validate failures (citation OOB, missing critical pages, …)
 *
 * Council members run in parallel (reviewConcurrency), use orthogonal lenses,
 * and merge with fingerprint dedupe + sticky prior blocking (ensemble pattern).
 */

import type { MergedDefectReport, WorkspaceOrchestration } from "@okf-wiki/contract";
import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import {
  applyStickyBlockingDefects,
  formatDefectsForRepair,
  writeMergedDefects,
} from "../../produce/defects.js";
import { emitProduceProgress } from "../../produce/progress.js";
import {
  type PublishabilityResult,
  scorePublishable,
  sourcesFromMounts,
} from "../../produce/publishability.js";
import { runReviewCouncil } from "../../produce/review.js";
import { reviewerPrompt, type ReviewLens } from "../../prompts/reviewer.js";
import { classifyAgentFailure, decideNodeRetry } from "../retry-policy.js";
import {
  cancelledResult,
  type PhaseContext,
  type ProduceWikiModelHandle,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";
import { runRepairWrite } from "./write-phase.js";

export type ReviewRepairPhaseResult = {
  result: ProduceWikiResult;
};

const REVIEW_LENSES: readonly ReviewLens[] = [
  "grounding",
  "coverage",
  "consistency",
  "general",
];

/** Format mechanical hard-validate reasons as repair instructions for root_write. */
export function hardValidateRepairText(reasons: readonly string[]): string {
  const bullets = reasons.map((r) => `- ${r}`).join("\n");
  return [
    "Hard-validate (mechanical) failures — fix these before publish:",
    bullets,
    "",
    "For citation line range out of bounds: re-open the cited source with read/grep,",
    "use only tool-reported 1-based line numbers, and set end ≤ the file's line count.",
    "Never invent or estimate ranges. Prefer edit of the bad Source Citations only.",
  ].join("\n");
}

/**
 * Shared fail-closed reviewer defect payload (reviewer_missing / reviewer_error).
 * `fenced` matches the live missing-model path which emits a markdown JSON fence.
 */
function reviewerBlockingDefectText(input: {
  code: "reviewer_missing" | "reviewer_error";
  issue: string;
  summary: string;
  fenced?: boolean;
}): string {
  const payload = JSON.stringify({
    clean: false,
    defects: [
      {
        severity: "blocking",
        code: input.code,
        issue: input.issue,
      },
    ],
    summary: input.summary,
  });
  return input.fenced ? ["```json", payload, "```"].join("\n") : payload;
}

function failedHardValidateResult(input: {
  produced: WikiWriteResult;
  spec: ProduceWikiResult["spec"];
  defects: MergedDefectReport | null;
  publishability: PublishabilityResult;
  metrics: ProduceWikiResult["metrics"];
}): ProduceWikiResult {
  const { produced, spec, defects, publishability, metrics } = input;
  return {
    status: "failed",
    pages: produced.pages,
    summary: `Produce failed hard-validate: ${publishability.reasons.slice(0, 5).join("; ")}`,
    spec,
    defects,
    publishability,
    layout: produced.layout,
    mode: produced.mode,
    metrics,
  };
}

/** Bounded-parallel map preserving item order (same pattern as research-phase). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

function seatModel(
  models: PhaseContext["input"]["models"],
  seatIndex: number,
): ProduceWikiModelHandle | undefined {
  const seats = models?.reviewers;
  if (seats && seats.length > 0) {
    return seats[seatIndex % seats.length] ?? models?.reviewer;
  }
  return models?.reviewer;
}

type CouncilMember = { id: string; text: string };

async function runOneReviewer(input: {
  ctx: PhaseContext;
  produced: WikiWriteResult;
  reviewerId: string;
  lens: ReviewLens;
  seatIndex: number;
  runIndex: number;
  priorBlocking: MergedDefectReport["defects"];
}): Promise<CouncilMember> {
  const { ctx, produced, reviewerId, lens, seatIndex, runIndex, priorBlocking } = input;
  const { runtime, layout } = ctx;
  const model = seatModel(ctx.input.models, seatIndex);
  const attemptId = `review@${runIndex}:${reviewerId}`;
  const maxReviewerAttempts = 2;
  let lastFailure = "";

  for (let attempt = 0; attempt < maxReviewerAttempts; attempt++) {
    try {
      const child = await runtime.runAgent({
        role: "reviewer",
        spanId: attempt === 0 ? attemptId : `${attemptId}~retry${attempt}`,
        nodeKey: "review",
        runIndex,
        runWorkDir: layout.runWorkDir,
        task: reviewerPrompt({
          pages: produced.pages,
          lens,
          ...(priorBlocking.length > 0
            ? {
                priorBlocking: priorBlocking.map((d) => ({
                  path: d.path,
                  code: d.code,
                  issue: d.issue,
                })),
              }
            : {}),
        }),
        model: model?.model,
        modelRuntime: model?.modelRuntime,
        maxContextTokens: model?.maxContextTokens,
        contextTargetTokens: ctx.contextTargetTokens,
        sourceIgnores: ctx.input.sourceIgnores,
        abortSignal: ctx.input.abortSignal,
        onProgress: (span) => emitProduceProgress(ctx.onProgress, { kind: "attempt", attempt: span }),
      });
      return { id: reviewerId, text: child.summary };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      lastFailure = err instanceof Error ? err.message : String(err);
      const retry = decideNodeRetry({
        errorClass: classifyAgentFailure(lastFailure),
        attemptIndex: attempt,
        maxAttempts: maxReviewerAttempts,
        message: lastFailure,
      });
      if (retry.action !== "retry") break;
      if (retry.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
      }
    }
  }

  return {
    id: reviewerId,
    text: reviewerBlockingDefectText({
      code: "reviewer_error",
      issue: `Reviewer failed: ${lastFailure}`,
      summary: `reviewer error: ${lastFailure}`,
    }),
  };
}

export async function runReviewRepairPhase(
  ctx: PhaseContext,
  producedIn: WikiWriteResult,
  orch: WorkspaceOrchestration,
): Promise<ReviewRepairPhaseResult> {
  const { input, onProgress, runtime, metrics, layout, spec, mode } = ctx;

  let produced = producedIn;
  let defects: MergedDefectReport | null = null;
  const maxRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 3);
  const reviewConcurrency = Math.max(
    1,
    Math.min(councilSize, orch.reviewConcurrency ?? councilSize),
  );
  const receiptIndex = await defaultReceiptStore.buildIndex(input.workspace.rootPath, input.runId);

  for (let round = 1; round <= maxRepair + 1; round++) {
    throwIfAborted(input.abortSignal);
    emitProduceProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: `review council round ${round} (${councilSize} seats, concurrency ${reviewConcurrency})`,
    });

    const priorBlocking =
      defects?.defects.filter((d) => d.severity === "blocking") ?? [];
    const priorMerged = defects;
    let reviewers: CouncilMember[] = [];

    if (runtime.kind === "live" && !input.models?.reviewer?.model && !input.models?.reviewers?.length) {
      // Fail closed: do not pretend the council is clean without a reviewer model.
      const msg = "Live Produce requires a reviewer model (or use fixture runtime)";
      reviewers = [
        {
          id: "reviewer-1",
          text: reviewerBlockingDefectText({
            code: "reviewer_missing",
            issue: msg,
            summary: msg,
            fenced: true,
          }),
        },
      ];
    } else {
      const runIndex = round - 1;
      const seats = Array.from({ length: councilSize }, (_, i) => i);
      try {
        reviewers = await mapWithConcurrency(
          seats,
          reviewConcurrency,
          input.abortSignal,
          async (seatIndex) => {
            const reviewerId = `reviewer-${seatIndex + 1}`;
            const lens = REVIEW_LENSES[seatIndex % REVIEW_LENSES.length]!;
            return runOneReviewer({
              ctx,
              produced,
              reviewerId,
              lens,
              seatIndex,
              runIndex,
              priorBlocking,
            });
          },
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            result: cancelledResult(spec, mode, metrics, layout, produced),
          };
        }
        throw err;
      }
    }

    let merged = await runReviewCouncil({
      reviewers,
      pages: produced.pages,
      workspaceRoot: input.workspace.rootPath,
      runId: input.runId,
      round,
    });
    // Sticky prior blocking when this round is not fully clean (ensemble stability).
    if (round > 1) {
      const withSticky = applyStickyBlockingDefects(merged, priorMerged);
      if (withSticky !== merged && withSticky.defects.length !== merged.defects.length) {
        await writeMergedDefects(input.workspace.rootPath, input.runId, withSticky);
        merged = withSticky;
      }
    }
    defects = merged;

    emitProduceProgress(onProgress, {
      kind: "defects",
      defects,
      summary: defects.summary ?? `Review round ${round}: ${defects.defects.length} defect(s)`,
    });

    const blocking = (spec.acceptance?.blockingSeverities ?? ["blocking"]) as string[];
    const hasBlocking = defects.defects.some((d) => blocking.includes(d.severity));
    if (defects.clean || !hasBlocking) {
      break;
    }
    if (round > maxRepair) {
      break;
    }

    metrics.repairRounds += 1;
    emitProduceProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: `repair round ${metrics.repairRounds} (${defects.defects.length} defects)`,
    });
    // Repair targets blocking only — majors stay advisory to reduce thrash.
    const defectText = formatDefectsForRepair(defects.defects, {
      severities: blocking as ("blocking" | "major" | "minor")[],
    });

    const repair = await runRepairWrite({
      ctx,
      produced,
      defectText:
        defectText ||
        formatDefectsForRepair(defects.defects, { severities: ["blocking"] }),
      receiptIndex,
    });
    if (repair.kind === "cancelled") {
      return { result: repair.result };
    }
    produced = repair.produced;
  }

  // Mechanical hard-validate with remaining shared repair budget (citation OOB, etc.).
  const sources = sourcesFromMounts(layout.sourceMounts);
  let publishability: PublishabilityResult = await scorePublishable({
    wikiRoot: produced.layout.wikiDir,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
    sources,
    spec,
    requireReviewReceipt: true,
  });

  while (!publishability.publishable) {
    if (metrics.repairRounds >= maxRepair) {
      emitProduceProgress(onProgress, {
        kind: "status",
        status: "producing",
        summary: publishability.reasons.slice(0, 3).join("; "),
      });
      if (defects) {
        emitProduceProgress(onProgress, { kind: "defects", defects });
      }
      return {
        result: failedHardValidateResult({
          produced,
          spec,
          defects,
          publishability,
          metrics,
        }),
      };
    }

    throwIfAborted(input.abortSignal);
    metrics.repairRounds += 1;
    const reasonPreview = publishability.reasons.slice(0, 3).join("; ");
    emitProduceProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: `hard-validate repair round ${metrics.repairRounds}: ${reasonPreview}`,
    });

    const repair = await runRepairWrite({
      ctx,
      produced,
      defectText: hardValidateRepairText(publishability.reasons),
      receiptIndex,
    });
    if (repair.kind === "cancelled") {
      return { result: repair.result };
    }
    produced = repair.produced;

    publishability = await scorePublishable({
      wikiRoot: produced.layout.wikiDir,
      workspaceRoot: input.workspace.rootPath,
      runId: input.runId,
      sources,
      spec,
      requireReviewReceipt: true,
    });
  }

  emitProduceProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: produced.summary,
  });
  emitProduceProgress(onProgress, { kind: "pages", pages: produced.pages });

  return {
    result: {
      status: "ready_for_publish",
      pages: produced.pages,
      summary: produced.summary,
      spec,
      defects,
      publishability,
      layout: produced.layout,
      mode: produced.mode,
      metrics,
    },
  };
}
