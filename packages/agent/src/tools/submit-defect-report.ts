/**
 * Review seat tool: validate DefectReportSchema and atomically write defect-report.json.
 * Path-first handoff (ADR 0011) — control returns a short ACK + path, not free-text defects.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type DefectReport,
  DefectReportSchema,
  SUBMIT_DEFECT_REPORT_TOOL_NAME,
} from "@okf-wiki/contract";
import { atomicWriteJson } from "@okf-wiki/core";

export { SUBMIT_DEFECT_REPORT_TOOL_NAME };

export const DEFECT_REPORT_FILE_NAME = "defect-report.json";

/** Run-workdir relative path for the seat DefectReport candidate. */
export const DEFECT_REPORT_REL_PATH = `analysis/${DEFECT_REPORT_FILE_NAME}`;

export function defectReportPathFromRunWorkDir(runWorkDir: string): string {
  return path.join(path.resolve(runWorkDir), "analysis", DEFECT_REPORT_FILE_NAME);
}

const defectItemSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("blocking"), Type.Literal("major"), Type.Literal("minor")], {
      description: "Defect severity: blocking | major | minor.",
    }),
    code: Type.String({
      description: "Stable defect code (1–80 chars), e.g. missing_citation.",
      minLength: 1,
      maxLength: 80,
    }),
    path: Type.Optional(
      Type.String({
        description: "Wiki-relative page path when the defect is page-scoped (max 200).",
        minLength: 1,
        maxLength: 200,
      }),
    ),
    issue: Type.String({
      description: "What is wrong and why it matters (1–2000 chars).",
      minLength: 1,
      maxLength: 2000,
    }),
    suggestedFix: Type.Optional(
      Type.String({
        description: "Optional concrete fix hint (max 2000 chars).",
        maxLength: 2000,
      }),
    ),
    reviewerId: Type.Optional(
      Type.String({
        description: "Optional reviewer id; product stamps seat id when omitted.",
        minLength: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

/** TypeBox surface for the reviewer; Zod DefectReportSchema is the truth gate. */
export const submitDefectReportParameters = Type.Object(
  {
    version: Type.Optional(
      Type.Literal(1, { description: "DefectReport schema version; only 1 is accepted." }),
    ),
    reviewerId: Type.String({
      description: "Seat / lens id (e.g. grounding, coverage). Must match the seat node.",
      minLength: 1,
    }),
    clean: Type.Boolean({
      description: "True only when defects is empty. False requires ≥1 defect.",
    }),
    defects: Type.Optional(
      Type.Array(defectItemSchema, {
        description: "Defect items. Empty iff clean is true.",
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description: "Short seat summary (max 2000 chars).",
        maxLength: 2000,
      }),
    ),
  },
  { additionalProperties: false },
);

export type SubmitDefectReportDetails = {
  reportPath: string;
  absolutePath: string;
  clean: boolean;
  defectCount: number;
  reviewerId: string;
};

export type CreateSubmitDefectReportToolInput = {
  runWorkDir: string;
  /** Seat reviewer id stamped when the model omits or mismatches. */
  reviewerId: string;
  /** Optional test hook. */
  writeReport?: (runWorkDir: string, report: DefectReport) => Promise<string>;
};

export async function writeDefectReportDraft(
  runWorkDir: string,
  report: DefectReport,
): Promise<string> {
  const parsed = DefectReportSchema.parse(report);
  const filePath = defectReportPathFromRunWorkDir(runWorkDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, parsed);
  return filePath;
}

export async function readDefectReportDraft(runWorkDir: string): Promise<DefectReport | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(defectReportPathFromRunWorkDir(runWorkDir), "utf8");
    const parsed = DefectReportSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createSubmitDefectReportTool(
  input: CreateSubmitDefectReportToolInput,
): ToolDefinition<typeof submitDefectReportParameters, SubmitDefectReportDetails> {
  const writeReport = input.writeReport ?? writeDefectReportDraft;
  return defineTool({
    name: SUBMIT_DEFECT_REPORT_TOOL_NAME,
    label: "Submit DefectReport",
    description: [
      "Submit a typed DefectReport for this review seat after reading wiki/ and sources/.",
      "Product validates DefectReportSchema and atomically writes analysis/defect-report.json.",
      "Call exactly once when the seat verdict is ready.",
      "",
      "When to use:",
      "- Review seat Attempt: pages inspected under your lens, ready to hand off clean or defects.",
      "",
      "Do not use when:",
      "- Still reading wiki/sources — keep using read-only tools until the verdict is complete.",
      "- Pasting DefectReport JSON into chat — the tool is the handoff; free-text is not accepted as success.",
    ].join("\n"),
    promptSnippet: "Submit typed DefectReport (writes analysis/defect-report.json)",
    promptGuidelines: [
      "After lens-scoped review, call submit_defect_report with clean/defects/summary.",
      "Do not paste the full DefectReport as chat text; the tool is the handoff.",
      "clean=true only with empty defects; clean=false requires ≥1 defect with severity/code/issue.",
      "Report every blocking defect supported by this lens; keep major/minor findings high-signal. severity is blocking | major | minor.",
    ],
    parameters: submitDefectReportParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const stamped = {
        ...params,
        version: 1 as const,
        reviewerId:
          typeof params.reviewerId === "string" && params.reviewerId.trim()
            ? params.reviewerId.trim()
            : input.reviewerId,
        defects: Array.isArray(params.defects)
          ? params.defects.map((d) => ({
              ...d,
              reviewerId:
                typeof d.reviewerId === "string" && d.reviewerId.trim()
                  ? d.reviewerId.trim()
                  : input.reviewerId,
            }))
          : [],
      };
      const parsed = DefectReportSchema.safeParse(stamped);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue
          ? `${issue.path.join(".") || "report"}: ${issue.message}`
          : "invalid DefectReport";
        throw new Error(
          `submit_defect_report rejected: ${where}. ` +
            "Fix clean/defects consistency (clean ⇔ empty defects) and call again. " +
            "Do not bypass via free-text chat.",
        );
      }
      const absolutePath = await writeReport(input.runWorkDir, parsed.data);
      const details: SubmitDefectReportDetails = {
        reportPath: DEFECT_REPORT_REL_PATH,
        absolutePath,
        clean: parsed.data.clean,
        defectCount: parsed.data.defects.length,
        reviewerId: parsed.data.reviewerId,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: parsed.data.clean
              ? `DefectReport accepted: clean (NO_DEFECTS) → ${DEFECT_REPORT_REL_PATH}`
              : `DefectReport accepted: ${details.defectCount} defect(s) → ${DEFECT_REPORT_REL_PATH}`,
          },
        ],
        details,
      };
    },
  });
}
