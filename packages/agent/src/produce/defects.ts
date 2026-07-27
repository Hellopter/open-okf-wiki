/**
 * Structured defect reports and merge. Fail-closed: blocking defects prevent publish.
 * Publishability scoring lives in publishability.ts.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type DefectItem,
  type DefectReport,
  DefectReportSchema,
  type DefectSeverity,
  type MergedDefectReport,
  MergedDefectReportSchema,
} from "@okf-wiki/contract";
import { defectsPath } from "./living-spec.js";

const SEVERITY_RANK: Record<DefectSeverity, number> = {
  blocking: 3,
  major: 2,
  minor: 1,
};

export function parseDefectReportFromText(text: string, reviewerId: string): DefectReport {
  const raw = text?.trim() ?? "";
  if (!raw) {
    return DefectReportSchema.parse({
      reviewerId,
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "empty_review",
          issue: "Reviewer returned empty output",
        },
      ],
      summary: "empty review",
    });
  }

  if (/NO_DEFECTS/i.test(raw) && !/severity\s*[:=]\s*blocking/i.test(raw)) {
    return DefectReportSchema.parse({
      reviewerId,
      clean: true,
      defects: [],
      summary: "NO_DEFECTS",
    });
  }

  // Prefer fenced JSON DefectReport.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence?.[1]) {
    try {
      const parsed = JSON.parse(fence[1]!) as unknown;
      const asReport = DefectReportSchema.safeParse({
        ...(typeof parsed === "object" && parsed ? parsed : {}),
        reviewerId,
      });
      if (asReport.success) {
        return asReport.data;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { defects?: unknown }).defects)
      ) {
        const defects = normalizeDefectItems((parsed as { defects: unknown[] }).defects);
        return DefectReportSchema.parse({
          reviewerId,
          clean: defects.length === 0,
          defects,
          summary:
            typeof (parsed as { summary?: unknown }).summary === "string"
              ? String((parsed as { summary: string }).summary).slice(0, 2000)
              : raw.slice(0, 500),
        });
      }
    } catch {
      // fall through
    }
  }

  // Line-oriented: severity: blocking | path | issue
  const defects: DefectItem[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || /^#{1,3}\s/.test(t) || /NO_DEFECTS/i.test(t)) {
      continue;
    }
    const sevMatch = t.match(/\b(blocking|major|minor)\b/i);
    const pathMatch = t.match(/`([^`]+\.md)`|([A-Za-z0-9_./-]+\.md)/);
    const severity = (sevMatch?.[1]?.toLowerCase() ?? "major") as DefectSeverity;
    const issue = t.replace(/^[-*]\s*/, "").slice(0, 2000);
    if (issue.length < 3) {
      continue;
    }
    defects.push({
      severity: SEVERITY_RANK[severity] ? severity : "major",
      code: "review_finding",
      path: pathMatch?.[1] ?? pathMatch?.[2],
      issue,
    });
  }

  if (defects.length === 0 && !/NO_DEFECTS/i.test(raw)) {
    defects.push({
      severity: "blocking",
      code: "unparsed_review",
      issue: raw.slice(0, 500),
    });
  }

  return DefectReportSchema.parse({
    reviewerId,
    clean: defects.length === 0,
    defects,
    summary: raw.slice(0, 500),
  });
}

function normalizeDefectItems(items: unknown[]): DefectItem[] {
  const out: DefectItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const severityRaw = String(o.severity ?? "major").toLowerCase();
    const severity = (
      severityRaw === "blocking" || severityRaw === "major" || severityRaw === "minor"
        ? severityRaw
        : "major"
    ) as DefectSeverity;
    const issue = String(o.issue ?? o.message ?? "").trim();
    if (!issue) {
      continue;
    }
    out.push({
      severity,
      code: String(o.code ?? "review_finding").slice(0, 80),
      path: o.path ? String(o.path).slice(0, 200) : undefined,
      issue: issue.slice(0, 2000),
      suggestedFix: o.suggestedFix ? String(o.suggestedFix).slice(0, 2000) : undefined,
    });
  }
  return out;
}

/**
 * Cross-reviewer fingerprint for ensemble merge (code + path + normalized issue).
 * Ignores reviewer id and severity so the same finding from two lenses collapses.
 */
export function defectFingerprint(d: {
  code?: string;
  path?: string;
  issue: string;
}): string {
  const code = (d.code ?? "review_finding").trim().toLowerCase();
  const pathKey = (d.path ?? "").trim().toLowerCase().replace(/\\/g, "/");
  const issue = d.issue
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9./:_ -]+/g, "")
    .trim()
    .slice(0, 120);
  return `${code}|${pathKey}|${issue}`;
}

/** System/infrastructure defects that must never be demoted by voting. */
const FORCE_KEEP_CODES = new Set([
  "empty_review",
  "unparsed_review",
  "reviewer_missing",
  "reviewer_error",
]);

export type MergeDefectReportsOptions = {
  /**
   * When council size ≥ 2, demote `major` findings reported by only one
   * reviewer to `minor` (reduces single-lens noise). Blocking never demotes.
   * Default true when ≥2 reports are merged.
   */
  demoteSingletonMajor?: boolean;
};

/**
 * Merge independent reviewer reports into one council result.
 *
 * - Cross-reviewer fingerprint dedupe (max severity wins)
 * - Optional demotion of singleton major when multiple reviewers ran
 * - Sort by severity descending
 */
export function mergeDefectReports(
  reports: DefectReport[],
  options: MergeDefectReportsOptions = {},
): MergedDefectReport {
  const reviewerIds: string[] = [];
  type Bucket = {
    defect: DefectItem;
    reporters: Set<string>;
  };
  const buckets = new Map<string, Bucket>();

  for (const r of reports) {
    reviewerIds.push(r.reviewerId);
    for (const d of r.defects) {
      const reviewerId = d.reviewerId ?? r.reviewerId;
      const fp = defectFingerprint(d);
      const existing = buckets.get(fp);
      if (!existing) {
        buckets.set(fp, {
          defect: { ...d, reviewerId },
          reporters: new Set([reviewerId]),
        });
        continue;
      }
      existing.reporters.add(reviewerId);
      if (SEVERITY_RANK[d.severity] > SEVERITY_RANK[existing.defect.severity]) {
        existing.defect = { ...d, reviewerId };
      }
    }
  }

  const councilSize = reports.length;
  const demoteSingletonMajor =
    options.demoteSingletonMajor ?? councilSize >= 2;

  const unique: DefectItem[] = [];
  for (const bucket of buckets.values()) {
    let severity = bucket.defect.severity;
    const code = bucket.defect.code ?? "review_finding";
    if (
      demoteSingletonMajor &&
      severity === "major" &&
      bucket.reporters.size === 1 &&
      !FORCE_KEEP_CODES.has(code)
    ) {
      severity = "minor";
    }
    unique.push({
      ...bucket.defect,
      severity,
      reviewerId: bucket.defect.reviewerId,
    });
  }

  unique.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return MergedDefectReportSchema.parse({
    clean: unique.length === 0,
    defects: unique,
    reviewerIds,
    summary:
      unique.length === 0
        ? "NO_DEFECTS"
        : `${unique.length} defect(s) from ${reviewerIds.length} reviewer(s)`,
  });
}

/**
 * Re-attach prior blocking defects that no reviewer re-reported (sticky open),
 * unless the new merge is fully clean (all lenses said NO_DEFECTS).
 */
export function applyStickyBlockingDefects(
  current: MergedDefectReport,
  prior: MergedDefectReport | null | undefined,
): MergedDefectReport {
  if (!prior || prior.clean) return current;
  if (current.clean) return current;

  const priorBlocking = prior.defects.filter((d) => d.severity === "blocking");
  if (priorBlocking.length === 0) return current;

  const seen = new Set(current.defects.map((d) => defectFingerprint(d)));
  const sticky: DefectItem[] = [];
  for (const d of priorBlocking) {
    const fp = defectFingerprint(d);
    if (seen.has(fp)) continue;
    seen.add(fp);
    sticky.push({
      ...d,
      code: d.code?.startsWith("sticky_") ? d.code : `sticky_${d.code ?? "blocking"}`.slice(0, 80),
      issue: d.issue.startsWith("[sticky]")
        ? d.issue
        : `[sticky] ${d.issue}`.slice(0, 2000),
    });
  }
  if (sticky.length === 0) return current;

  const reviewerIds = [...new Set([...current.reviewerIds, ...prior.reviewerIds])];
  const defects = [...current.defects, ...sticky].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  return MergedDefectReportSchema.parse({
    clean: false,
    defects,
    reviewerIds,
    summary: `${defects.length} defect(s) (${sticky.length} sticky) from ${reviewerIds.length} reviewer(s)`,
  });
}

/** Format defects for writer repair prompts (blocking-only by default). */
export function formatDefectsForRepair(
  defects: readonly DefectItem[],
  options?: { severities?: DefectSeverity[] },
): string {
  const allowed = new Set(options?.severities ?? (["blocking"] as DefectSeverity[]));
  const lines = defects
    .filter((d) => allowed.has(d.severity))
    .map((d) => `- [${d.severity}] ${d.path ?? "?"} ${d.code ?? ""}: ${d.issue}`);
  return lines.join("\n");
}

export function hasBlockingDefects(
  merged: MergedDefectReport,
  blockingSeverities: DefectSeverity[] = ["blocking"],
): boolean {
  const set = new Set(blockingSeverities);
  return merged.defects.some((d) => set.has(d.severity));
}

export async function writeMergedDefects(
  workspaceRoot: string,
  runId: string,
  report: MergedDefectReport,
): Promise<string> {
  const parsed = MergedDefectReportSchema.parse(report);
  const filePath = defectsPath(workspaceRoot, runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  return filePath;
}

export async function readMergedDefects(
  workspaceRoot: string,
  runId: string,
): Promise<MergedDefectReport | null> {
  try {
    const raw = await readFile(defectsPath(workspaceRoot, runId), "utf8");
    return MergedDefectReportSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
