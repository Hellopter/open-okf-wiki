/**
 * Pure helpers for the operator fix gate (gate.fix / kind "fix").
 *
 * Decisions: pass | fix | revise | deny. ResolveGate always uses gateKind: "fix".
 */

import type {
  DefectItem,
  FixGateDecision,
  MergedDefectReport,
  ResolveGateCommand,
  WikiRunAttempt,
  WikiRunGate,
  WikiRunSnapshot,
} from "@okf-wiki/contract";

export type { FixGateDecision };

export type FixGateDefectHint = {
  severity?: DefectItem["severity"];
  code?: string;
  path?: string;
  issue: string;
  suggestedFix?: string;
  reviewerId?: string;
};

export type FixGateContext = {
  /** Free-text summary when defects artifact is not loaded. */
  summary: string | null;
  /** Defect rows from a MergedDefectReport, or attempt-error hints. */
  defects: FixGateDefectHint[];
  clean: boolean | null;
};

export type BuildFixGateResolveCommandInput = {
  runId: string;
  gateId: string;
  payloadDigest: string;
  decision: FixGateDecision;
  /** Required when decision is revise. */
  feedback?: string;
  commandId?: string;
};

/**
 * Build a ResolveGate command for an open fix gate.
 * Throws if revise is missing non-empty feedback.
 * `fix` may carry optional notes (workflow schedules repair.review.N).
 */
export function buildFixGateResolveCommand(
  input: BuildFixGateResolveCommandInput,
): ResolveGateCommand {
  const feedback = input.feedback?.trim() ?? "";
  if (input.decision === "revise" && !feedback) {
    throw new Error("fix gate revise requires feedback");
  }
  const includeFeedback =
    (input.decision === "revise" || input.decision === "fix") && feedback.length > 0;
  return {
    type: "resolve_gate",
    commandId: input.commandId?.trim() || crypto.randomUUID(),
    runId: input.runId,
    gateId: input.gateId,
    gateKind: "fix",
    payloadDigest: input.payloadDigest,
    decision: input.decision,
    ...(includeFeedback ? { feedback } : {}),
  };
}

/** Prefer plan, then fix, then publication, then any open gate. */
export function selectPrimaryOpenGate(
  gates: readonly WikiRunGate[],
): WikiRunGate | null {
  const open = gates.filter((g) => g.state === "open");
  return (
    open.find((g) => g.kind === "plan") ??
    open.find((g) => g.kind === "fix") ??
    open.find((g) => g.kind === "publication") ??
    open[0] ??
    null
  );
}

function defectsFromReport(report: MergedDefectReport): FixGateContext {
  return {
    summary: report.summary?.trim() || null,
    defects: report.defects.map((d) => ({
      severity: d.severity,
      code: d.code,
      path: d.path,
      issue: d.issue,
      suggestedFix: d.suggestedFix,
      reviewerId: d.reviewerId,
    })),
    clean: report.clean,
  };
}

/**
 * Operator-facing fix context: prefer a sealed defects report when provided;
 * else gate.detail (summary / blockingCount); else attempt-error hints.
 */
export function fixGateContextFromSnapshot(
  snapshot: WikiRunSnapshot | null | undefined,
  options?: {
    defectsReport?: MergedDefectReport | null;
    /** Open fix gate (uses sealed detail when present). */
    gate?: WikiRunGate | null;
    /** Optional free-text override from gate payload / detail. */
    gateSummary?: string | null;
  },
): FixGateContext {
  if (options?.defectsReport) {
    return defectsFromReport(options.defectsReport);
  }

  const detail = options?.gate?.detail;
  const gateSummary =
    options?.gateSummary?.trim() ||
    detail?.summary?.trim() ||
    (detail?.blockingCount != null && detail.blockingCount > 0
      ? `${detail.blockingCount} blocking defect(s)`
      : null) ||
    null;

  if (!snapshot) {
    return {
      summary: gateSummary,
      defects: [],
      clean: detail?.clean ?? null,
    };
  }

  const ranked = [...snapshot.attempts].sort((a, b) => b.runIndex - a.runIndex);
  const hints: FixGateDefectHint[] = [];
  const seen = new Set<string>();
  for (const attempt of ranked) {
    if (hints.length >= 12) break;
    if (attempt.state !== "failed" && attempt.state !== "interrupted") continue;
    if (!isFixRelatedNodeKey(attempt.nodeKey)) continue;
    const issue = attempt.error?.trim();
    if (!issue) continue;
    const key = `${attempt.nodeKey}:${issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      path: attempt.nodeKey,
      issue,
      code: attempt.failureClass,
    });
  }

  const summary =
    gateSummary ||
    (hints.length > 0
      ? `${hints.length} issue(s) from validate/review/repair attempts`
      : null);

  return {
    summary,
    defects: hints,
    clean: detail?.clean ?? (hints.length === 0 ? null : false),
  };
}

function isFixRelatedNodeKey(nodeKey: string): boolean {
  return (
    nodeKey.startsWith("validate.") ||
    nodeKey.startsWith("review.") ||
    nodeKey.startsWith("repair") ||
    nodeKey.startsWith("write.")
  );
}

/** Latest failed/interrupted attempt error for a node key family (debug chrome). */
export function latestAttemptError(
  attempts: readonly WikiRunAttempt[],
  nodeKeyPrefix: string,
): string | null {
  const ranked = [...attempts]
    .filter((a) => a.nodeKey.startsWith(nodeKeyPrefix))
    .sort((a, b) => b.runIndex - a.runIndex);
  for (const a of ranked) {
    const err = a.error?.trim();
    if (err) return err;
  }
  return null;
}
