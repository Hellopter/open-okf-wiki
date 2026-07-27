/**
 * Review council merge + defects.json persist (Produce-internal).
 */

import type { MergedDefectReport } from "@okf-wiki/contract";
import { writeAnalysisReceipt } from "@okf-wiki/core";
import { mergeDefectReports, parseDefectReportFromText } from "./defects.js";
import { writeMergedDefects } from "./defects-io.js";

export type ReviewerOutput = {
  id: string;
  text: string;
};

export async function runReviewCouncil(input: {
  reviewers: ReviewerOutput[];
  pages: string[];
  workspaceRoot: string;
  runId: string;
  round?: number;
}): Promise<MergedDefectReport> {
  const round = input.round ?? 1;
  const pageList = input.pages.join(", ");

  const reports = await Promise.all(
    input.reviewers.map(async (reviewer, index) => {
      const reviewerId = reviewer.id?.trim() || `reviewer-${index + 1}`;
      const report = parseDefectReportFromText(reviewer.text ?? "", reviewerId);
      try {
        await writeAnalysisReceipt(input.workspaceRoot, {
          version: 1,
          runId: input.runId,
          nodeId: `${reviewerId}-r${round}`,
          parentId: "root",
          attempt: round,
          status: "complete",
          scope: `staged pages: ${pageList}`,
          summary: report.summary ?? (report.clean ? "NO_DEFECTS" : "defects"),
          findings: report.clean
            ? ["NO_DEFECTS"]
            : report.defects.map((d) => `[${d.severity}] ${d.path ?? "?"}: ${d.issue}`),
          evidence: [],
          childReceipts: [],
          openQuestions: [],
        });
      } catch {
        // best-effort receipt
      }
      return report;
    }),
  );

  const merged = mergeDefectReports(reports);
  await writeMergedDefects(input.workspaceRoot, input.runId, merged);
  return merged;
}
