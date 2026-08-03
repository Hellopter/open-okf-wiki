/**
 * review.seat: lens-scoped wiki review Attempt.
 *
 * Fail-closed (hard-cut Epic D): seat succeeds only with a validated
 * DefectReportSchema via submit_defect_report → analysis/defect-report.json.
 * Free-text chat JSON is never admitted.
 */

import { type PiAttemptOutcome, PiAttemptOutcomeSchema } from "@okf-wiki/contract/pi-attempt";
import {
  type DefectReport,
  DefectReportSchema,
  type MergedDefectReport,
  MergedDefectReportSchema,
  SUBMIT_DEFECT_REPORT_TOOL_NAME,
} from "@okf-wiki/contract/wiki-runs";
import { listWikiMarkdown } from "../../wiki-pages.js";
import { type ReviewLens, reviewerPrompt } from "../../../prompts/index.js";
import {
  commitDefectReport,
  readDefectReport,
} from "../../../review/commit-defect-report.js";
import { createSubmitDefectReportTool } from "../../../tools/submit-defect-report.js";
import {
  formatOperatorInputNotes,
  loadProjectedDefectsText,
  loadProjectedOperatorInput,
} from "../projection.js";
import {
  type AttemptHandlerContext,
  bounded,
  failAttempt,
  forwardScopedProgress,
  liveModel,
  metricsFromSeatRun,
  parseNodeDetail,
  resolveReviewSeatIndex,
  seatModelId,
  sealTranscript,
  writeAnalysisJson,
} from "../shared.js";

const REVIEW_SYSTEM = [
  "You are a wiki reviewer.",
  `You MUST call the ${SUBMIT_DEFECT_REPORT_TOOL_NAME} tool with a typed DefectReport.`,
  "analysis/defect-report.json is the only handoff — free-text chat JSON is never accepted.",
  "Prefer fail-closed blocking only for true defects.",
].join(" ");

function reviewerIdForSeat(lens: string): string {
  return lens;
}

async function loadPriorBlocking(
  layout: AttemptHandlerContext["layout"],
): Promise<DefectReport["defects"]> {
  const text = await loadProjectedDefectsText(layout);
  if (!text) return [];
  try {
    const parsed = MergedDefectReportSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return [];
    return parsed.data.defects.filter((d) => d.severity === "blocking" || d.severity === "major");
  } catch {
    return [];
  }
}

/**
 * Resolve a validated DefectReport from analysis/defect-report.json only.
 * Never invents clean NO_DEFECTS on missing/malformed output.
 */
export async function resolveSeatDefectReport(input: {
  workDir: string;
  reviewerId: string;
}): Promise<{ ok: true; report: DefectReport; source: "tool" } | { ok: false; error: string }> {
  const fromTool = await readDefectReport(input.workDir);
  if (fromTool) {
    // Re-stamp reviewerId to the seat when the draft used a different id.
    const stamped = DefectReportSchema.safeParse({
      ...fromTool,
      reviewerId: input.reviewerId,
      defects: fromTool.defects.map((d) => ({
        ...d,
        reviewerId: d.reviewerId ?? input.reviewerId,
      })),
    });
    if (stamped.success) return { ok: true, report: stamped.data, source: "tool" };
    return {
      ok: false,
      error: `submit_defect_report wrote an invalid DefectReport: ${stamped.error.issues[0]?.message ?? "schema"}`,
    };
  }

  return {
    ok: false,
    error:
      `review.seat failed: missing validated DefectReport ` +
      `(call ${SUBMIT_DEFECT_REPORT_TOOL_NAME} → analysis/defect-report.json). ` +
      `Free-text chat is never accepted; malformed/missing reviewer output is never treated as clean.`,
  };
}

export async function handleReviewSeat(ctx: AttemptHandlerContext): Promise<PiAttemptOutcome> {
  const { input, layout, ignores, runtime, resolveModel, signal } = ctx;
  const detail = parseNodeDetail(input);
  const lens = detail.lens as ReviewLens;
  const reviewerId = reviewerIdForSeat(lens);
  const seatIndex = resolveReviewSeatIndex(input);
  const pages = await listWikiMarkdown(layout.wikiDir);
  const priorBlocking = await loadPriorBlocking(layout);

  const resolved =
    runtime.kind === "live"
      ? await liveModel(input, "reviewer", resolveModel, { seatIndex })
      : undefined;

  const reviewTask = reviewerPrompt({
    pages,
    lens,
    priorBlocking: priorBlocking.map((d) => ({
      path: d.path,
      code: d.code,
      issue: d.issue,
    })),
  });
  const operatorNotes = formatOperatorInputNotes(await loadProjectedOperatorInput(layout));

  const seat = { modelId: seatModelId(resolved), role: "review" as const };
  const result = await runtime.runAgent({
    role: "reviewer",
    spanId: input.attemptId,
    nodeKey: input.node.key,
    runIndex: input.node.runIndex,
    runWorkDir: input.workDir,
    task: [
      ...(operatorNotes ? [operatorNotes, ""] : []),
      reviewTask,
      "",
      `You MUST call ${SUBMIT_DEFECT_REPORT_TOOL_NAME} with reviewerId=${JSON.stringify(reviewerId)}.`,
      "clean=true only with empty defects; otherwise list severity/code/issue defects.",
      "Do not paste DefectReport JSON into chat — the tool is the only handoff.",
    ].join("\n"),
    systemPrompt: REVIEW_SYSTEM,
    preferFinalMessage: true,
    model: resolved?.model,
    modelRuntime: resolved?.modelRuntime,
    maxContextTokens: resolved?.model.contextWindow,
    contextTargetTokens: input.workspace.limits.contextTargetTokens,
    retry: input.workspace.limits.retry,
    sourceIgnores: ignores,
    abortSignal: signal,
    timeoutMs: input.workspace.limits.requestTimeoutSeconds * 1_000,
    additionalSkillPaths: [layout.skillDir],
    transcriptPath: input.sessionPath,
    customTools: [
      createSubmitDefectReportTool({
        runWorkDir: input.workDir,
        reviewerId,
      }),
    ],
    onProgress: (p) => forwardScopedProgress(ctx, p, seat),
  });
  if (result.failed) throw new Error(result.summary);

  const resolvedReport = await resolveSeatDefectReport({
    workDir: input.workDir,
    reviewerId,
  });
  if (!resolvedReport.ok) {
    return failAttempt(input, {
      error: resolvedReport.error,
      failureClass: "schema",
      task: reviewTask,
      items: result.items,
      meta: { lens, seatIndex, defectSource: "missing" },
    });
  }

  const report = resolvedReport.report;
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, report);
  // Also keep the canonical draft path for reduce/debug.
  await commitDefectReport(input.workDir, report, { reviewerId });

  const summaryText =
    report.summary?.trim() || (report.clean ? "NO_DEFECTS" : `${report.defects.length} defect(s)`);
  const transcript = await sealTranscript(input, {
    task: reviewTask,
    items: result.items,
    summary: summaryText,
    terminal: "done",
    meta: {
      mode: result.mode,
      lens,
      seatIndex,
      defectSource: resolvedReport.source,
      clean: report.clean,
      defectCount: report.defects.length,
    },
  });
  return PiAttemptOutcomeSchema.parse({
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "receipt", role: "review_seat", sourcePath: receiptPath, directory: false },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary: bounded(summaryText),
    metrics: metricsFromSeatRun({
      role: "review",
      modelId: seatModelId(resolved),
      fromRun: result.metrics,
    }),
  });
}

/** @internal test helper — re-export prior blocking parse surface. */
export function priorBlockingFromMerged(report: MergedDefectReport): DefectReport["defects"] {
  return report.defects.filter((d) => d.severity === "blocking" || d.severity === "major");
}
