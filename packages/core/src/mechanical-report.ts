/**
 * MechanicalIssue helpers + MechanicalReport assembly.
 *
 * Validate produces structured issues; this module maps them into the contract
 * MechanicalReport without English-string code heuristics.
 */

import {
  type MechanicalFixHint,
  type MechanicalIssue,
  type MechanicalIssueCode,
  type MechanicalReport,
  MechanicalReportSchema,
} from "@okf-wiki/contract/wiki-runs";

/** Structural input for report assembly (avoids validate-wiki ↔ report cycle). */
export type MechanicalReportSource = {
  ok: boolean;
  issues: readonly MechanicalIssue[];
  /** Compat mirror; when omitted, derived from issue messages. */
  errors?: readonly string[];
  warnings?: readonly string[];
  pageCount?: number;
  fileCount?: number;
  citationCount?: number;
};

export type MakeMechanicalIssueInput = {
  code: MechanicalIssueCode;
  message: string;
  path?: string;
  autoFixable?: boolean;
  fixHint?: MechanicalFixHint;
  raw?: string;
};

/**
 * Build a contract MechanicalIssue with length clamps matching the schema.
 */
export function makeMechanicalIssue(input: MakeMechanicalIssueInput): MechanicalIssue {
  const message = input.message.trim().slice(0, 4_000) || input.code;
  const issue: MechanicalIssue = {
    code: input.code,
    message,
    autoFixable: input.autoFixable ?? false,
  };
  if (input.path?.trim()) {
    issue.path = input.path.trim().replace(/\\/g, "/").slice(0, 500);
  }
  if (input.fixHint) {
    issue.fixHint = input.fixHint;
  }
  const raw = (input.raw ?? input.message).slice(0, 8_000);
  if (raw) {
    issue.raw = raw;
  }
  return issue;
}

/**
 * Build a contract MechanicalReport from structured validation output.
 */
export function toMechanicalReport(
  result: MechanicalReportSource,
  opts?: { candidateId?: string },
): MechanicalReport {
  const issues = [...result.issues];
  const errors =
    result.errors && result.errors.length > 0
      ? [...result.errors]
      : issues.map((issue) => issue.message);
  return MechanicalReportSchema.parse({
    ...(opts?.candidateId ? { candidateId: opts.candidateId } : {}),
    ok: result.ok,
    issues,
    warnings: result.warnings ? [...result.warnings] : [],
    pageCount: result.pageCount,
    fileCount: result.fileCount,
    citationCount: result.citationCount,
    /** Compat mirror — issue messages for legacy consumers. */
    errors,
  });
}

/**
 * Extract a wiki-relative path prefix when a free-text message looks like
 * `path.md: …`. Used only by legacy repair fallbacks that lack a sealed report.
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

/**
 * Extract unique wiki page paths from a free-text validation / feedback message.
 * Prefer issue.path from a sealed MechanicalReport when available.
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

/**
 * Unique page paths from structured MechanicalIssue rows (preferred over free-text).
 */
export function extractPagesFromMechanicalIssues(issues: readonly MechanicalIssue[]): string[] {
  const pages: string[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const path = issue.path?.trim().replace(/\\/g, "/");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    pages.push(path);
  }
  return pages;
}
