/**
 * Review council + bounded repair loop (Run Workflow phase / T2).
 */

import type { MergedDefectReport } from "@okf-wiki/contract";
import type { WikiWriteResult } from "../../ports/agent-runner.js";
import { emitProduceProgress } from "../../produce/progress.js";
import { defaultReceiptStore } from "../../ports/core-receipt-store.js";
import {
  type PublishabilityResult,
  scorePublishable,
  sourcesFromMounts,
} from "../../produce/publishability.js";
import { runReviewCouncil } from "../../produce/review.js";
import { reviewerPrompt } from "../../prompts/index.js";
import { decideNodeRetry } from "../retry-policy.js";
import { runRepairWrite } from "./write-phase.js";
import {
  cancelledResult,
  type PhaseContext,
  type ProduceWikiResult,
  throwIfAborted,
} from "./types.js";

export type ReviewRepairPhaseResult = {
  result: ProduceWikiResult;
};

export async function runReviewRepairPhase(
  ctx: PhaseContext,
  producedIn: WikiWriteResult,
  orch: { reviewCouncilSize?: number },
): Promise<ReviewRepairPhaseResult> {
  const {
    input,
    onProgress,
    runtime,
    metrics,
    layout,
    spec,
    mode,
  } = ctx;

  let produced = producedIn;
  let defects: MergedDefectReport | null = null;
  const maxRepair = Math.max(0, spec.acceptance?.maxRepairRounds ?? 2);
  const councilSize = Math.max(1, orch.reviewCouncilSize ?? 1);
  const lenses = ["grounding", "coverage", "consistency", "general"] as const;
  const receiptIndex = await defaultReceiptStore.buildIndex(
    input.workspace.rootPath,
    input.runId,
  );

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
        text: [
          "```json",
          JSON.stringify({
            clean: false,
            defects: [
              {
                severity: "blocking",
                code: "reviewer_missing",
                issue: msg,
              },
            ],
            summary: msg,
          }),
          "```",
        ].join("\n"),
      });
    } else {
      for (let i = 0; i < councilSize; i++) {
        const reviewerId = `reviewer-${i + 1}`;
        const lens = lenses[i % lenses.length]!;
        try {
          const child = await runtime.runAgent({
            role: "reviewer",
            spanId: `${reviewerId}-${lens}`,
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
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return {
              result: cancelledResult(spec, mode, metrics, layout, produced),
            };
          }
          const msg = err instanceof Error ? err.message : String(err);
          const retry = decideNodeRetry({
            errorClass: "transient",
            attemptIndex: 0,
            maxAttempts: 1,
            message: msg,
          });
          void retry;
          reviewers.push({
            id: reviewerId,
            text: JSON.stringify({
              clean: false,
              defects: [
                {
                  severity: "blocking",
                  code: "reviewer_error",
                  issue: `Reviewer failed: ${msg}`,
                },
              ],
              summary: `reviewer error: ${msg}`,
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

  const sources = sourcesFromMounts(layout.sourceMounts);
  const publishability: PublishabilityResult = await scorePublishable({
    wikiRoot: produced.layout.wikiDir,
    workspaceRoot: input.workspace.rootPath,
    runId: input.runId,
    sources,
    spec,
    requireReviewReceipt: true,
  });

  if (!publishability.publishable) {
    emitProduceProgress(onProgress, {
      kind: "status",
      status: "producing",
      summary: publishability.reasons.slice(0, 3).join("; "),
    });
    if (defects) {
      emitProduceProgress(onProgress, { kind: "defects", defects });
    }
    return {
      result: {
        status: "failed",
        pages: produced.pages,
        summary: `Produce failed hard-validate: ${publishability.reasons.slice(0, 5).join("; ")}`,
        spec,
        defects,
        publishability,
        layout: produced.layout,
        mode: produced.mode,
        metrics,
      },
    };
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
