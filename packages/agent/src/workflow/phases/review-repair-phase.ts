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

import type { DefectSeverity, MergedDefectReport, WorkspaceOrchestration } from "@okf-wiki/contract";
import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import { applyStickyBlockingDefects, hasBlockingDefects } from "../../produce/defects.js";
import { writeMergedDefects } from "../../produce/defects-io.js";
import { emitProgress } from "../../ports/progress-sink.js";
import {
  type PublishabilityResult,
  scorePublishable,
  sourcesFromMounts,
} from "../../produce/publishability.js";
import { listWikiMarkdown, materializeWikiIndexes } from "../../produce/wiki-pages.js";
import { runReviewCouncil } from "../../produce/review.js";
import { reviewerPrompt, type ReviewLens } from "../../prompts/reviewer.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";
import { runNodeAttempt } from "../run-node-attempt.js";
import { runBoundedRepairLoop } from "./bounded-repair-loop.js";
import {
  formatDefectsForRepair,
  hardValidateRepairText,
  partitionHardValidateReasons,
} from "./repair-prompt.js";
import {
  cancelledResult,
  failedProduceResult,
  type PhaseContext,
  type ProduceWikiModelHandle,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";
import { runRepairWrite } from "./write-phase.js";

export type ReviewRepairPhaseResult = {
  result: ProduceWikiResult;
};

/** Re-export repair prompt helpers for tests that imported from this phase. */
export {
  formatDefectsForRepair,
  hardValidateRepairText,
  isIndexHardValidateReason,
  partitionHardValidateReasons,
} from "./repair-prompt.js";

const REVIEW_LENSES: readonly ReviewLens[] = [
  "grounding",
  "coverage",
  "consistency",
  "general",
];

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

  const text = await runNodeAttempt({
    abortSignal: ctx.input.abortSignal,
    maxAttempts: maxReviewerAttempts,
    nodeKey: "review",
    role: "reviewer",
    attemptId: (attempt) => (attempt === 0 ? attemptId : `${attemptId}~retry${attempt}`),
    run: async (attempt) => {
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
        systemPrompt:
          "You are a wiki reviewer. Return a concise DefectReport JSON (or NO_DEFECTS).",
        preferFinalMessage: true,
        model: model?.model,
        modelRuntime: model?.modelRuntime,
        maxContextTokens: model?.maxContextTokens,
        contextTargetTokens: ctx.contextTargetTokens,
        sourceIgnores: ctx.input.sourceIgnores,
        abortSignal: ctx.input.abortSignal,
        onProgress: (span) => emitProgress(ctx.onProgress, { kind: "attempt", attempt: span }),
      });
      return child.summary;
    },
    onExhausted: (_err, { message }) =>
      reviewerBlockingDefectText({
        code: "reviewer_error",
        issue: `Reviewer failed: ${message}`,
        summary: `reviewer error: ${message}`,
      }),
  });

  return { id: reviewerId, text };
}

function hardValidateFailedResult(input: {
  produced: WikiWriteResult;
  spec: ProduceWikiResult["spec"];
  defects: MergedDefectReport | null;
  publishability: PublishabilityResult;
  metrics: ProduceWikiResult["metrics"];
}): ProduceWikiResult {
  const { produced, spec, defects, publishability, metrics } = input;
  return failedProduceResult({
    summary: `Produce failed hard-validate: ${publishability.reasons.slice(0, 5).join("; ")}`,
    pages: produced.pages,
    spec,
    defects,
    publishability,
    layout: produced.layout,
    mode: produced.mode,
    metrics,
  });
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
  const blockingSeverities = (spec.acceptance?.blockingSeverities ?? [
    "blocking",
  ]) as DefectSeverity[];

  // --- Council score + repair (shared budget) ---
  const councilOutcome = await runBoundedRepairLoop({
    maxRepair,
    metrics,
    score: async ({ round }) => {
      throwIfAborted(input.abortSignal);
      emitProgress(onProgress, {
        kind: "status",
        status: "producing",
        summary: `review council round ${round} (${councilSize} seats, concurrency ${reviewConcurrency})`,
      });

      const priorBlocking =
        defects?.defects.filter((d) => d.severity === "blocking") ?? [];
      const priorMerged = defects;
      let reviewers: CouncilMember[] = [];

      if (
        runtime.kind === "live" &&
        !input.models?.reviewer?.model &&
        !input.models?.reviewers?.length
      ) {
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
              kind: "cancelled" as const,
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

      emitProgress(onProgress, {
        kind: "defects",
        defects,
        summary: defects.summary ?? `Review round ${round}: ${defects.defects.length} defect(s)`,
      });

      if (defects.clean || !hasBlockingDefects(defects, blockingSeverities)) {
        return { kind: "pass" as const };
      }

      // Repair targets blocking only — majors stay advisory to reduce thrash.
      const defectText =
        formatDefectsForRepair(defects.defects, { severities: blockingSeverities }) ||
        formatDefectsForRepair(defects.defects, { severities: ["blocking"] });
      return { kind: "repair" as const, repairText: defectText };
    },
    onBeforeRepair: ({ repairRound }) => {
      emitProgress(onProgress, {
        kind: "status",
        status: "producing",
        summary: `repair round ${repairRound} (${defects?.defects.length ?? 0} defects)`,
      });
    },
    repair: async (defectText) => {
      const repair = await runRepairWrite({
        ctx,
        produced,
        defectText,
        receiptIndex,
      });
      if (repair.kind === "cancelled") {
        return { kind: "cancelled", result: repair.result };
      }
      produced = repair.produced;
      return { kind: "ok" };
    },
  });

  if (councilOutcome.kind === "cancelled") {
    return { result: councilOutcome.result };
  }
  // passed | exhausted | failed — council does not fail_closed; exhausted falls through
  // to hard-validate which fails closed if still unpublishable.

  // Mechanical hard-validate with remaining shared repair budget (citation OOB, etc.).
  // Re-materialize indexes once first — cheap drift fix that must not burn model repair rounds.
  const sources = sourcesFromMounts(layout.sourceMounts);
  emitProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: "hard-validate: materialize indexes",
  });
  await materializeWikiIndexes(produced.layout.wikiDir);
  produced = {
    ...produced,
    pages: await listWikiMarkdown(produced.layout.wikiDir),
  };

  let publishability: PublishabilityResult = {
    publishable: false,
    reasons: [],
    pages: produced.pages,
    defects: null,
  };

  const hardValidateOutcome = await runBoundedRepairLoop({
    maxRepair,
    metrics,
    score: async () => {
      publishability = await scorePublishable({
        wikiRoot: produced.layout.wikiDir,
        workspaceRoot: input.workspace.rootPath,
        runId: input.runId,
        sources,
        spec,
        requireReviewReceipt: true,
      });

      if (publishability.publishable) {
        return { kind: "pass" as const };
      }

      const { writerReasons } = partitionHardValidateReasons(publishability.reasons);

      // Index-only failures after product materialize are not model work — fail closed.
      if (writerReasons.length === 0) {
        emitProgress(onProgress, {
          kind: "status",
          status: "producing",
          summary: publishability.reasons.slice(0, 3).join("; "),
        });
        if (defects) {
          emitProgress(onProgress, { kind: "defects", defects });
        }
        return {
          kind: "fail_closed" as const,
          result: hardValidateFailedResult({
            produced,
            spec,
            defects,
            publishability,
            metrics,
          }),
        };
      }

      // Abort before budget consume (loop increments after score returns repair).
      throwIfAborted(input.abortSignal);
      return {
        kind: "repair" as const,
        repairText: hardValidateRepairText(writerReasons),
      };
    },
    onBeforeRepair: ({ repairRound }) => {
      const { writerReasons } = partitionHardValidateReasons(publishability.reasons);
      const reasonPreview = writerReasons.slice(0, 3).join("; ");
      emitProgress(onProgress, {
        kind: "status",
        status: "producing",
        summary: `hard-validate repair round ${repairRound}: ${reasonPreview}`,
      });
    },
    repair: async (defectText) => {
      // Only non-index reasons go to the writer (indexes are re-materialized by repair write).
      const repair = await runRepairWrite({
        ctx,
        produced,
        defectText,
        receiptIndex,
      });
      if (repair.kind === "cancelled") {
        return { kind: "cancelled", result: repair.result };
      }
      produced = repair.produced;
      return { kind: "ok" };
    },
  });

  if (hardValidateOutcome.kind === "cancelled") {
    return { result: hardValidateOutcome.result };
  }
  if (hardValidateOutcome.kind === "failed") {
    return { result: hardValidateOutcome.result };
  }
  if (hardValidateOutcome.kind === "exhausted") {
    emitProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: publishability.reasons.slice(0, 3).join("; "),
    });
    if (defects) {
      emitProgress(onProgress, { kind: "defects", defects });
    }
    return {
      result: hardValidateFailedResult({
        produced,
        spec,
        defects,
        publishability,
        metrics,
      }),
    };
  }

  // passed
  emitProgress(onProgress, {
    kind: "status",
    status: "producing",
    summary: produced.summary,
  });
  emitProgress(onProgress, { kind: "pages", pages: produced.pages });

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
