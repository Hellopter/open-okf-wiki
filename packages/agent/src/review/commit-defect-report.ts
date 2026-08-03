/**
 * Deep module: validate and atomically commit a review-seat DefectReport.
 *
 * Path-first handoff (ADR 0011 / hard-cut Epic D): analysis/defect-report.json
 * is the only admission path. Free-text chat JSON is never accepted.
 * Tools stay thin (TypeBox + dispatch here).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type DefectReport,
  DefectReportSchema,
} from "@okf-wiki/contract/wiki-runs";
import { atomicWriteJson } from "@okf-wiki/core";

export const DEFECT_REPORT_FILE_NAME = "defect-report.json";

/** Run-workdir relative path for the seat DefectReport candidate. */
export const DEFECT_REPORT_REL_PATH = `analysis/${DEFECT_REPORT_FILE_NAME}`;

export function defectReportPathFromRunWorkDir(runWorkDir: string): string {
  return path.join(path.resolve(runWorkDir), "analysis", DEFECT_REPORT_FILE_NAME);
}

export type CommitDefectReportOptions = {
  /**
   * Seat reviewer id stamped when the report omits or blanks reviewerId
   * (and defect item reviewerId).
   */
  reviewerId?: string;
};

export type CommitDefectReportResult = {
  absolutePath: string;
  reportPath: string;
  report: DefectReport;
  clean: boolean;
  defectCount: number;
  reviewerId: string;
};

/**
 * Stamp optional seat reviewerId, Zod-validate DefectReportSchema, then
 * atomically write analysis/defect-report.json.
 */
export async function commitDefectReport(
  runWorkDir: string,
  report: unknown,
  opts?: CommitDefectReportOptions,
): Promise<CommitDefectReportResult> {
  const seatId = opts?.reviewerId?.trim() || undefined;
  const raw =
    report && typeof report === "object" && !Array.isArray(report)
      ? (report as Record<string, unknown>)
      : {};
  const stamped = {
    ...raw,
    version: 1 as const,
    reviewerId:
      typeof raw.reviewerId === "string" && raw.reviewerId.trim()
        ? raw.reviewerId.trim()
        : seatId,
    defects: Array.isArray(raw.defects)
      ? raw.defects.map((d) => {
          if (!d || typeof d !== "object" || Array.isArray(d)) return d;
          const item = d as Record<string, unknown>;
          return {
            ...item,
            reviewerId:
              typeof item.reviewerId === "string" && item.reviewerId.trim()
                ? item.reviewerId.trim()
                : seatId,
          };
        })
      : raw.defects ?? [],
  };

  const parsed = DefectReportSchema.safeParse(stamped);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue
      ? `${issue.path.join(".") || "report"}: ${issue.message}`
      : "invalid DefectReport";
    throw new Error(
      `commitDefectReport rejected: ${where}. ` +
        "Fix clean/defects consistency (clean ⇔ empty defects) and resubmit. " +
        "Do not bypass via free-text chat.",
    );
  }

  const absolutePath = defectReportPathFromRunWorkDir(runWorkDir);
  await atomicWriteJson(absolutePath, parsed.data);
  return {
    absolutePath,
    reportPath: DEFECT_REPORT_REL_PATH,
    report: parsed.data,
    clean: parsed.data.clean,
    defectCount: parsed.data.defects.length,
    reviewerId: parsed.data.reviewerId,
  };
}

/** Read seat DefectReport from disk (null when missing/invalid). */
export async function readDefectReport(runWorkDir: string): Promise<DefectReport | null> {
  try {
    const raw = await readFile(defectReportPathFromRunWorkDir(runWorkDir), "utf8");
    const parsed = DefectReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** @deprecated alias — prefer readDefectReport. */
export const readDefectReportDraft = readDefectReport;

/**
 * Write a pre-validated DefectReport (or re-validate via commit).
 * Prefer commitDefectReport for new call sites.
 */
export async function writeDefectReportDraft(
  runWorkDir: string,
  report: DefectReport,
): Promise<string> {
  const result = await commitDefectReport(runWorkDir, report);
  return result.absolutePath;
}
