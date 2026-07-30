/**
 * review.seat: lens-scoped wiki review Attempt.
 *
 * Fail-closed (Phase 3): seat succeeds only with a validated DefectReportSchema
 * via submit_defect_report (preferred) or a single free-text JSON parse fallback.
 * Malformed / missing reports never become clean NO_DEFECTS.
 */

import {
  type DefectReport,
  DefectReportSchema,
  type MergedDefectReport,
  MergedDefectReportSchema,
  type PiAttemptOutcome,
  PiAttemptOutcomeSchema,
  SUBMIT_DEFECT_REPORT_TOOL_NAME,
} from "@okf-wiki/contract";
import { listWikiMarkdown } from "../../../produce/wiki-pages.js";
import { type ReviewLens, reviewerPrompt } from "../../../prompts/index.js";
import {
  createSubmitDefectReportTool,
  readDefectReportDraft,
  writeDefectReportDraft,
} from "../../../tools/submit-defect-report.js";
import {
  formatOperatorInputNotes,
  loadProjectedDefectsText,
  loadProjectedOperatorInput,
} from "../materialize.js";
import {
  type AttemptHandlerContext,
  bounded,
  liveModel,
  parseNodeDetail,
  resolveReviewSeatIndex,
  sealTranscript,
  writeAnalysisJson,
} from "../shared.js";

const REVIEW_SYSTEM = [
  "You are a wiki reviewer.",
  `Submit your verdict with the ${SUBMIT_DEFECT_REPORT_TOOL_NAME} tool (typed DefectReport).`,
  "Do not rely on free-text chat as the handoff. Prefer fail-closed blocking only for true defects.",
].join(" ");

function reviewerIdForSeat(lens: string): string {
  return lens;
}

function tryParseDefectReportJson(text: string, reviewerId: string): DefectReport | null {
  const raw = text.trim();
  if (!raw) return null;
  const candidates: string[] = [raw];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) candidates.push(fence[1]!.trim());
  // Prefer a trailing JSON object if the model mixed prose + JSON once.
  const brace = raw.indexOf("{");
  if (brace >= 0) candidates.push(raw.slice(brace));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      const stamped = {
        version: 1 as const,
        reviewerId:
          typeof obj.reviewerId === "string" && obj.reviewerId.trim()
            ? obj.reviewerId.trim()
            : reviewerId,
        clean: obj.clean,
        defects: Array.isArray(obj.defects)
          ? obj.defects.map((d) => {
              if (!d || typeof d !== "object" || Array.isArray(d)) return d;
              const item = d as Record<string, unknown>;
              return {
                ...item,
                reviewerId:
                  typeof item.reviewerId === "string" && item.reviewerId.trim()
                    ? item.reviewerId.trim()
                    : reviewerId,
              };
            })
          : obj.defects,
        summary: obj.summary,
      };
      const report = DefectReportSchema.safeParse(stamped);
      if (report.success) return report.data;
    } catch {
      // try next candidate
    }
  }
  return null;
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
 * Resolve a validated DefectReport: disk draft from submit tool, else one free-text parse.
 * Never invents clean NO_DEFECTS on missing/malformed output.
 */
export async function resolveSeatDefectReport(input: {
  workDir: string;
  reviewerId: string;
  summaryText: string;
}): Promise<
  { ok: true; report: DefectReport; source: "tool" | "free_text" } | { ok: false; error: string }
> {
  const fromTool = await readDefectReportDraft(input.workDir);
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

  const fromText = tryParseDefectReportJson(input.summaryText, input.reviewerId);
  if (fromText) {
    await writeDefectReportDraft(input.workDir, fromText);
    return { ok: true, report: fromText, source: "free_text" };
  }

  return {
    ok: false,
    error:
      `review.seat failed: missing validated DefectReport ` +
      `(call ${SUBMIT_DEFECT_REPORT_TOOL_NAME} or emit one JSON DefectReport). ` +
      `Malformed/missing reviewer output is never treated as clean.`,
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
  });
  if (result.failed) throw new Error(result.summary);

  const resolvedReport = await resolveSeatDefectReport({
    workDir: input.workDir,
    reviewerId,
    summaryText: result.summary,
  });
  if (!resolvedReport.ok) {
    return PiAttemptOutcomeSchema.parse({
      type: "failed",
      error: resolvedReport.error,
      failureClass: "schema",
    });
  }

  const report = resolvedReport.report;
  const receiptPath = await writeAnalysisJson(layout, `${input.node.key}.json`, report);
  // Also keep the canonical draft path for reduce/debug.
  await writeDefectReportDraft(input.workDir, report);

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
  });
}

/** @internal test helper — re-export prior blocking parse surface. */
export function priorBlockingFromMerged(report: MergedDefectReport): DefectReport["defects"] {
  return report.defects.filter((d) => d.severity === "blocking" || d.severity === "major");
}
