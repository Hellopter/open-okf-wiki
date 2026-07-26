/**
 * Review council + bounded repair loop (Run Workflow phase / T2).
 *
 * Repair budget (`maxRepairRounds`) is shared by:
 * 1. Review-council blocking defects
 * 2. Mechanical hard-validate failures (citation OOB, missing critical pages, …)
 *
 * Hard-validate used to be terminal after the review loop; citation line-range
 * errors then failed the run with no in-run fix path. They now re-enter
 * root_write repair while budget remains.
 */

import type { MergedDefectReport } from "@okf-wiki/contract";
import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import { emitProduceProgress } from "../../produce/progress.js";
import {
  type PublishabilityResult,
  scorePublishable,
  sourcesFromMounts,
} from "../../produce/publishability.js";
import { runReviewCouncil } from "../../produce/review.js";
import { reviewerPrompt } from "../../prompts/index.js";
import { classifyAgentFailure, decideNodeRetry } from "../retry-policy.js";
import {
  cancelledResult,
  type PhaseContext,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";
import { runRepairWrite } from "./write-phase.js";

export type ReviewRepairPhaseResult = {
  result: ProduceWikiResult;
};

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

export async function runReviewRepairPhase(
  ctx: PhaseContext,
  producedIn: WikiWriteResult,
  orch: { reviewCouncilSize?: number },
): Promise<ReviewRepairPhaseResult> {
  const { input, onProgress, runtime, metrics, layout, spec, mode } = ctx;

  let produced = producedIn;
  let defects: MergedDefectReport | null = null;
  const maxRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 1);
  const lenses = ["grounding", "coverage", "consistency", "general"] as const;
  const receiptIndex = await defaultReceiptStore.buildIndex(input.workspace.rootPath, input.runId);

  for (let round = 1; round <= maxRepair + 1; round++) {
    throwIfAborted(input.abortSignal);
    emitProduceProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: `review council round ${round}`,
    });

    const reviewers: Array<{ id: string; text: string }> = [];

    if (runtime.kind === "live" && !input.models?.reviewer?.model) {
      // Fail closed: do not pretend the council is clean without a reviewer model.
      const msg = "Live Produce requires a reviewer model (or use fixture runtime)";
      reviewers.push({
        id: "reviewer-1",
        text: reviewerBlockingDefectText({
          code: "reviewer_missing",
          issue: msg,
          summary: msg,
          fenced: true,
        }),
      });
    } else {
      // Topology has a single `review` node; council members + rounds are attempts.
      // attemptId must be unique per member/round so append-only graph keeps history.
      const runIndex = round - 1;
      for (let i = 0; i < councilSize; i++) {
        const reviewerId = `reviewer-${i + 1}`;
        const lens = lenses[i % lenses.length]!;
        const attemptId = `review@${runIndex}:${reviewerId}`;
        // Retry policy (T1): a failed council member gets one policy-driven
        // retry (transient/unknown); if it still fails, its slot becomes a
        // blocking reviewer_error defect (fail closed, never a silent pass).
        const maxReviewerAttempts = 2;
        let reviewed = false;
        let lastFailure = "";
        for (let attempt = 0; attempt < maxReviewerAttempts && !reviewed; attempt++) {
          try {
            const child = await runtime.runAgent({
              role: "reviewer",
              spanId: attempt === 0 ? attemptId : `${attemptId}~retry${attempt}`,
              nodeKey: "review",
              runIndex,
              runWorkDir: layout.runWorkDir,
              task: reviewerPrompt({ pages: produced.pages, lens }),
              model: input.models?.reviewer?.model,
              modelRuntime: input.models?.reviewer?.modelRuntime,
              maxContextTokens: input.models?.reviewer?.maxContextTokens,
              contextTargetTokens: ctx.contextTargetTokens,
              sourceIgnores: input.sourceIgnores,
              abortSignal: input.abortSignal,
              onProgress: (span) =>
                emitProduceProgress(onProgress, { kind: "attempt", attempt: span }),
            });
            reviewers.push({ id: reviewerId, text: child.summary });
            reviewed = true;
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
              return {
                result: cancelledResult(spec, mode, metrics, layout, produced),
              };
            }
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
        if (!reviewed) {
          reviewers.push({
            id: reviewerId,
            text: reviewerBlockingDefectText({
              code: "reviewer_error",
              issue: `Reviewer failed: ${lastFailure}`,
              summary: `reviewer error: ${lastFailure}`,
            }),
          });
        }
      }
    }

    defects = await runReviewCouncil({
      reviewers,
      pages: produced.pages,
      workspaceRoot: input.workspace.rootPath,
      runId: input.runId,
      round,
    });
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
    const defectText = defects.defects
      .map((d) => `- [${d.severity}] ${d.path ?? "?"} ${d.code ?? ""}: ${d.issue}`)
      .join("\n");

    const repair = await runRepairWrite({
      ctx,
      produced,
      defectText,
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
