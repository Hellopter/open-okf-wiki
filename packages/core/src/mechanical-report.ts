/**
 * Map validateWikiTree error strings into contract MechanicalIssue / MechanicalReport.
 *
 * Heuristics are intentionally string-based so host autofix and model repair can
 * share one issue vocabulary without re-running the full tree walk.
 */

import {
  type MechanicalFixHint,
  type MechanicalIssue,
  type MechanicalIssueCode,
  type MechanicalReport,
  MechanicalReportSchema,
} from "@okf-wiki/contract";
import type { ValidateWikiResult } from "./validate-wiki.js";

/**
 * Extract a wiki-relative path prefix when the error looks like `path.md: …`.
 * Returns undefined for free-form messages (caps, missing critical page, …).
 */
export function extractPathFromValidateError(error: string): string | undefined {
  const trimmed = error.trim();
  // `foo.md: message` or `domain/bar.md: message`
  const md = trimmed.match(/^((?:[\w.-]+\/)*[\w.-]+\.md)\s*:\s+/i);
  if (md?.[1]) return md[1].replace(/\\/g, "/");
  // Nested non-.md relative path prefix (rare load issues)
  const rel = trimmed.match(/^((?:[\w.-]+\/)+[\w.-]+)\s*:\s+/);
  if (rel?.[1]) return rel[1].replace(/\\/g, "/");
  return undefined;
}

type IssueClassification = {
  code: MechanicalIssueCode;
  autoFixable: boolean;
  fixHint?: MechanicalFixHint;
};

function classifyValidateError(error: string): IssueClassification {
  if (/line range out of bounds|out of bounds/i.test(error)) {
    return { code: "citation_oob", autoFixable: true, fixHint: "clamp_lines" };
  }
  if (/not found in Snapshot|citation target not found/i.test(error)) {
    return { code: "citation_unresolved", autoFixable: false };
  }
  if (/citation path must|multi-source citation/i.test(error)) {
    return { code: "citation_format", autoFixable: false };
  }
  if (/missing Source Citation/i.test(error)) {
    return { code: "missing_citation", autoFixable: false };
  }
  if (/missing YAML frontmatter|missing.*type|missing.*title/i.test(error)) {
    return { code: "missing_frontmatter", autoFixable: false };
  }
  if (/critical page missing/i.test(error)) {
    return { code: "missing_critical_page", autoFixable: false };
  }
  // Plan coverage gaps (SOURCE_COVERAGE / SURFACE_COVERAGE / CROSS_SOURCE_FLOW).
  // Contract MechanicalIssueCode has no dedicated coverage codes yet → "other".
  if (/^SOURCE_COVERAGE:|^SURFACE_COVERAGE:|^CROSS_SOURCE_FLOW:/i.test(error)) {
    return { code: "other", autoFixable: false };
  }
  if (/symlink/i.test(error)) {
    return { code: "symlink", autoFixable: false };
  }
  if (/max .*files|files \(max|1MB|oversized|max file size|exceeds max file/i.test(error)) {
    return { code: "cap_exceeded", autoFixable: false };
  }
  return { code: "other", autoFixable: false };
}

/**
 * Map raw validateWikiTree error strings to MechanicalIssue rows.
 */
export function mechanicalIssuesFromErrors(errors: string[]): MechanicalIssue[] {
  const issues: MechanicalIssue[] = [];
  for (const raw of errors) {
    const message = raw.trim();
    if (!message) continue;
    const classified = classifyValidateError(message);
    const path = extractPathFromValidateError(message);
    const issue: MechanicalIssue = {
      code: classified.code,
      message: message.slice(0, 4_000),
      raw: raw.slice(0, 8_000),
      autoFixable: classified.autoFixable,
      ...(path ? { path } : {}),
      ...(classified.fixHint ? { fixHint: classified.fixHint } : {}),
    };
    issues.push(issue);
  }
  return issues;
}

/**
 * Build a contract MechanicalReport from a ValidateWikiResult.
 */
export function toMechanicalReport(
  result: ValidateWikiResult,
  opts?: { candidateId?: string },
): MechanicalReport {
  const issues = mechanicalIssuesFromErrors(result.errors);
  return MechanicalReportSchema.parse({
    ...(opts?.candidateId ? { candidateId: opts.candidateId } : {}),
    ok: result.ok,
    issues,
    warnings: result.warnings ?? [],
    pageCount: result.pageCount,
    fileCount: result.fileCount,
    citationCount: result.citationCount,
    /** Compat mirror — keep original error strings for legacy consumers. */
    errors: result.errors,
  });
}

/**
 * Extract unique wiki page paths from a validation / feedback message
 * (segments shaped like `path.md: …`). The complete report remains the
 * authority; this helper only derives its deterministic page index.
 */
export function extractPagesFromValidationMessage(message: string): string[] {
  const pages: string[] = [];
  const seen = new Set<string>();
  // Split on common joiners used when packing validate errors into one string.
  const segments = message.split(/;\s*|\n+/);
  for (const segment of segments) {
    const path = extractPathFromValidateError(segment.replace(/^validation failed:\s*/i, ""));
    if (!path || seen.has(path)) continue;
    seen.add(path);
    pages.push(path);
  }
  // Also scan whole message for `foo.md:` tokens when joiners are absent.
  const re = /((?:[\w.-]+\/)*[\w.-]+\.md)\s*:/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    const path = match[1]!.replace(/\\/g, "/");
    if (seen.has(path)) continue;
    seen.add(path);
    pages.push(path);
  }
  return pages;
}
