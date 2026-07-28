/**
 * Review council + mechanical hard-validate with independent repair budgets (T2).
 *
 * Phase order:
 * 1. Front-load mechanical hard-validate (own `maxHardValidateRepairRounds`)
 * 2. Review-council blocking defects (`maxRepairRounds` / `metrics.repairRounds`)
 * 3. Post-council hard-validate with remaining HV budget (fail-closed if still dirty)
 *
 * Council members run in parallel (reviewConcurrency), use orthogonal lenses,
 * and merge with fingerprint dedupe + sticky prior blocking (ensemble pattern).
 */

import type {
  DefectSeverity,
  ErrorClass,
  MergedDefectReport,
  WorkspaceOrchestration,
} from "@okf-wiki/contract";
import { canonicalizeWikiTreeCitations } from "@okf-wiki/core";
import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import { applyStickyBlockingDefects, hasBlockingDefects } from "../../produce/defects.js";
import { writeMergedDefects } from "../../produce/defects-io.js";
import {
  type PublishabilityResult,
  scorePublishable,
  sourcesFromMounts,
} from "../../produce/publishability.js";
import { listWikiMarkdown, materializeWikiIndexes } from "../../produce/wiki-pages.js";
import { runReviewCouncil } from "../../produce/review.js";
import { reviewerPrompt, type ReviewLens } from "../../prompts/reviewer.js";
import { mapWithConcurrency } from "../map-with-concurrency.js";
import { classifyError } from "../retry-policy.js";
import { runNodeAttempt } from "../run-node-attempt.js";
import {
  runBoundedRepairLoop,
  type BoundedRepairLoopResult,
} from "./bounded-repair-loop.js";
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
 * L2 maxAttempts for a single reviewer seat (schema/quality only).
 * Transient/capacity fail on first L2 attempt via retry-policy.
 * Kept separate from RESEARCH_MAX_ATTEMPTS and repair-round budget.
 */
export const REVIEWER_MAX_ATTEMPTS = 2;

/**
 * Config-missing fail-closed defect only (`reviewer_missing`).
 * Transport/capacity/infra must not become DefectItems — they fail the seat or run.
 */
function reviewerMissingDefectText(input: {
  issue: string;
  summary: string;
  fenced?: boolean;
}): string {
  const payload = JSON.stringify({
    clean: false,
    defects: [
      {
        severity: "blocking",
        code: "reviewer_missing",
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

type ReviewerSeatOutcome =
  | { kind: "ok"; member: CouncilMember }
  | { kind: "failed"; id: string; message: string; errorClass?: ErrorClass };

async function runOneReviewer(input: {
  ctx: PhaseContext;
  produced: WikiWriteResult;
  reviewerId: string;
  lens: ReviewLens;
  seatIndex: number;
  runIndex: number;
  priorBlocking: MergedDefectReport["defects"];
}): Promise<ReviewerSeatOutcome> {
  const { ctx, produced, reviewerId, lens, seatIndex, runIndex, priorBlocking } = input;
  const { runtime, layout } = ctx;
  const model = seatModel(ctx.input.models, seatIndex);
  const attemptId = `review@${runIndex}:${reviewerId}`;
  // L2 maxAttempts only helps schema/quality; transient/capacity fail on first L2 attempt.

  try {
    const text = await runNodeAttempt({
      abortSignal: ctx.input.abortSignal,
      maxAttempts: REVIEWER_MAX_ATTEMPTS,
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
          onProgress: (span) => ctx.progress.emit({ kind: "attempt", attempt: span }),
        });
        return child.summary;
      },
      // Never synthesize reviewer_error defects for infra/transport — rethrow to seat outcome.
      onExhausted: "throw",
    });
    return { kind: "ok", member: { id: reviewerId, text } };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    const message = err instanceof Error ? err.message : String(err);
    const errorClass = classifyError(err);
    return {
      kind: "failed",
      id: reviewerId,
      message,
      ...(errorClass !== undefined ? { errorClass } : {}),
    };
  }
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

/** Review receipt / blocking-defect reasons are not mechanical writer work. */
function isReviewStateHardValidateReason(reason: string): boolean {
  return (
    reason.startsWith("blocking defects remain") || reason.startsWith("review required")
  );
}

/**
 * Mechanical hard-validate score + repair loop.
 * Shares `metrics.hardValidateRepairRounds` across pre- and post-council calls
 * so remaining budget after front-load HV is available after council.
 */
async function runHardValidateRepairLoop(input: {
  ctx: PhaseContext;
  produced: WikiWriteResult;
  defects: MergedDefectReport | null;
  maxHardValidate: number;
  label: string;
  /**
   * Pre-council HV is mechanical only (no defects.json yet).
   * Post-council HV requires review receipt when acceptance.reviewRequired.
   */
  requireReviewReceipt: boolean;
}): Promise<{
  outcome: BoundedRepairLoopResult;
  produced: WikiWriteResult;
  publishability: PublishabilityResult;
}> {
  const { ctx, maxHardValidate, label, requireReviewReceipt } = input;
  const { input: wikiInput, progress, metrics, layout, spec } = ctx;
  let produced = input.produced;
  const defects = input.defects;

  const sources = sourcesFromMounts(layout.sourceMounts);
  progress.emit({
    kind: "status",
    status: "producing",
    summary: `${label}: materialize indexes`,
  });
  await materializeWikiIndexes(produced.layout.wikiDir);
  produced = {
    ...produced,
    pages: await listWikiMarkdown(produced.layout.wikiDir),
  };

  // Host path identity: strip run-mount `sources/<id>/…` to Skill repo-relative form.
  // Re-run on every hard-validate score (including after repair writes) so staging
  // stays contract-clean; resolve also canonicalizes as a second line of defense.
  const citationCanon = {
    sourceIds: [...layout.sourceMounts.keys()],
    multiSource: layout.sourceMounts.size > 1,
  };

  let publishability: PublishabilityResult = {
    publishable: false,
    reasons: [],
    pages: produced.pages,
    defects: null,
  };

  const receiptIndex = await defaultReceiptStore.buildIndex(
    wikiInput.workspace.rootPath,
    wikiInput.runId,
  );

  const outcome = await runBoundedRepairLoop({
    maxRepair: maxHardValidate,
    metrics,
    budgetKey: "hardValidateRepairRounds",
    score: async () => {
      await canonicalizeWikiTreeCitations(produced.layout.wikiDir, citationCanon);
      publishability = await scorePublishable({
        wikiRoot: produced.layout.wikiDir,
        workspaceRoot: wikiInput.workspace.rootPath,
        runId: wikiInput.runId,
        sources,
        spec,
        requireReviewReceipt,
      });

      if (publishability.publishable) {
        return { kind: "pass" as const };
      }

      const { writerReasons } = partitionHardValidateReasons(publishability.reasons);
      // Review-state reasons need another council pass — not mechanical HV repair.
      const mechanicalReasons = writerReasons.filter((r) => !isReviewStateHardValidateReason(r));

      // Index-only or review-state-only: not model HV work — fail closed without budget.
      if (mechanicalReasons.length === 0) {
        progress.emit({
          kind: "status",
          status: "producing",
          summary: publishability.reasons.slice(0, 3).join("; "),
        });
        if (defects) {
          progress.emit({ kind: "defects", defects });
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
      throwIfAborted(wikiInput.abortSignal);
      return {
        kind: "repair" as const,
        repairText: hardValidateRepairText(mechanicalReasons),
      };
    },
    onBeforeRepair: ({ repairRound }) => {
      const { writerReasons } = partitionHardValidateReasons(publishability.reasons);
      const reasonPreview = writerReasons.slice(0, 3).join("; ");
      progress.emit({
        kind: "status",
        status: "producing",
        summary: `${label} repair round ${repairRound}: ${reasonPreview}`,
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

  return { outcome, produced, publishability };
}

function hardValidateTerminal(
  outcome: BoundedRepairLoopResult,
  input: {
    produced: WikiWriteResult;
    spec: ProduceWikiResult["spec"];
    defects: MergedDefectReport | null;
    publishability: PublishabilityResult;
    metrics: ProduceWikiResult["metrics"];
    progress: PhaseContext["progress"];
  },
): ProduceWikiResult | null {
  const { produced, spec, defects, publishability, metrics, progress } = input;
  if (outcome.kind === "cancelled") return outcome.result;
  if (outcome.kind === "failed") return outcome.result;
  if (outcome.kind === "exhausted") {
    progress.emit({
      kind: "status",
      status: "producing",
      summary: publishability.reasons.slice(0, 3).join("; "),
    });
    if (defects) {
      progress.emit({ kind: "defects", defects });
    }
    return hardValidateFailedResult({
      produced,
      spec,
      defects,
      publishability,
      metrics,
    });
  }
  return null; // passed
}

export async function runReviewRepairPhase(
  ctx: PhaseContext,
  producedIn: WikiWriteResult,
  orch: WorkspaceOrchestration,
): Promise<ReviewRepairPhaseResult> {
  const { input, progress, runtime, metrics, layout, spec, mode } = ctx;

  let produced = producedIn;
  let defects: MergedDefectReport | null = null;
  const maxCouncilRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const maxHardValidate = Math.max(0, spec.acceptance?.maxHardValidateRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 3);
  const reviewConcurrency = Math.max(
    1,
    Math.min(councilSize, orch.reviewConcurrency ?? councilSize),
  );
  const receiptIndex = await defaultReceiptStore.buildIndex(input.workspace.rootPath, input.runId);
  const blockingSeverities = (spec.acceptance?.blockingSeverities ?? [
    "blocking",
  ]) as DefectSeverity[];

  // --- 1. Front-load mechanical hard-validate (own budget; no review receipt yet) ---
  {
    const hv = await runHardValidateRepairLoop({
      ctx,
      produced,
      defects,
      maxHardValidate,
      label: "hard-validate",
      requireReviewReceipt: false,
    });
    produced = hv.produced;
    const terminal = hardValidateTerminal(hv.outcome, {
      produced,
      spec,
      defects,
      publishability: hv.publishability,
      metrics,
      progress,
    });
    if (terminal) return { result: terminal };
  }

  // --- 2. Council score + repair (council-only budget) ---
  const councilOutcome = await runBoundedRepairLoop({
    maxRepair: maxCouncilRepair,
    metrics,
    budgetKey: "repairRounds",
    score: async ({ round }) => {
      // Abort before returning repair so cancellation does not consume budget.
      throwIfAborted(input.abortSignal);
      progress.emit({
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
            text: reviewerMissingDefectText({
              issue: msg,
              summary: msg,
              fenced: true,
            }),
          },
        ];
      } else {
        const runIndex = round - 1;
        const seats = Array.from({ length: councilSize }, (_, i) => i);
        let seatOutcomes: ReviewerSeatOutcome[] = [];
        try {
          seatOutcomes = await mapWithConcurrency(
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

        const okSeats = seatOutcomes.filter(
          (o): o is Extract<ReviewerSeatOutcome, { kind: "ok" }> => o.kind === "ok",
        );
        const failedSeats = seatOutcomes.filter(
          (o): o is Extract<ReviewerSeatOutcome, { kind: "failed" }> => o.kind === "failed",
        );
        if (failedSeats.length > 0) {
          progress.emit({
            kind: "status",
            status: "producing",
            summary: `review seats failed: ${failedSeats
              .map((s) => `${s.id}${s.errorClass ? `(${s.errorClass})` : ""}`)
              .join(", ")}`,
          });
        }
        // All seats failed on transport/capacity/infra — fail produce, do not invent defects or repair.
        if (okSeats.length === 0) {
          const first = failedSeats[0];
          const reason =
            first?.message?.trim() ||
            "all review council seats failed (no successful reviewer output)";
          const cls = first?.errorClass ?? "infrastructure";
          return {
            kind: "fail_closed" as const,
            result: failedProduceResult({
              summary: `Review council failed (${cls}): ${reason}`,
              pages: produced.pages,
              spec,
              defects: null,
              publishability: {
                publishable: false,
                reasons: [
                  `review_council: ${cls}: ${reason}`,
                  ...failedSeats.slice(0, 4).map(
                    (s) => `${s.id}: ${s.errorClass ?? "error"}: ${s.message.slice(0, 200)}`,
                  ),
                ],
                pages: produced.pages,
                defects: null,
              },
              layout: produced.layout,
              mode: produced.mode,
              metrics,
            }),
          };
        }
        reviewers = okSeats.map((o) => o.member);
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

      progress.emit({
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
      // Abort before budget consume (loop increments after score returns repair).
      throwIfAborted(input.abortSignal);
      return { kind: "repair" as const, repairText: defectText };
    },
    onBeforeRepair: ({ repairRound }) => {
      progress.emit({
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
  // All seats failed (infra/capacity/transient) → fail_closed from score.
  if (councilOutcome.kind === "failed") {
    return { result: councilOutcome.result };
  }
  // passed | exhausted — exhausted falls through to post-council hard-validate.
  // Council may have left blocking defects; scorePublishable fail-closes on them.

  // --- 3. Post-council hard-validate (remaining HV budget + review receipt) ---
  {
    const hv = await runHardValidateRepairLoop({
      ctx,
      produced,
      defects,
      maxHardValidate,
      label: "post-council hard-validate",
      requireReviewReceipt: true,
    });
    produced = hv.produced;
    const terminal = hardValidateTerminal(hv.outcome, {
      produced,
      spec,
      defects,
      publishability: hv.publishability,
      metrics,
      progress,
    });
    if (terminal) return { result: terminal };

    // passed
    progress.emit({
      kind: "status",
      status: "producing",
      summary: produced.summary,
    });
    progress.emit({ kind: "pages", pages: produced.pages });

    return {
      result: {
        status: "ready_for_publish",
        pages: produced.pages,
        summary: produced.summary,
        spec,
        defects,
        publishability: hv.publishability,
        layout: produced.layout,
        mode: produced.mode,
        metrics,
      },
    };
  }
}
