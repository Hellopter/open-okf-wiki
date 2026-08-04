/**
 * Pure plan-review helpers (no React / network). Safe for node:test.
 */

import type { CoverageResult, CoverageResultRow, CoverageRowStatus, CoverageStopReason } from "@okf-wiki/contract/coverage";
import type { WikiRunGate, WikiRunPlanReview } from "@okf-wiki/contract/wiki-runs";

export type PlanReviewStatus = "idle" | "loading" | "ready" | "pending" | "stale" | "error";

export type PlanReviewState = {
  status: PlanReviewStatus;
  review: WikiRunPlanReview | null;
  error: unknown;
  /** Expected payloadDigest from open plan gate (if any). */
  expectedPayloadDigest: string | null;
};

export function planReviewHeadline(
  state: Pick<PlanReviewState, "review" | "status">,
  gate: WikiRunGate | undefined,
  copy: { fallback: string; loading: string },
): string {
  if (state.review?.spec.summary?.trim()) return state.review.spec.summary.trim();
  if (gate?.detail?.summary?.trim()) return gate.detail.summary.trim();
  if (state.status === "loading" || state.status === "stale") return copy.loading;
  return copy.fallback;
}

export function openPlanGateFromSnapshot(
  gates: readonly WikiRunGate[] | undefined,
): WikiRunGate | undefined {
  return gates?.find((gate) => gate.state === "open" && gate.kind === "plan");
}

/** Domain/page chrome counts without inventing missing numbers. */
export function formatDomainPageCounts(
  domains: number | undefined,
  pages: number | undefined,
  template: string,
  format: (template: string, vars: Record<string, string | number>) => string,
): string | null {
  if (typeof domains === "number" && typeof pages === "number") {
    return format(template, { domains, pages });
  }
  return null;
}

/**
 * Whether observation should load plan-review materials for this snapshot.
 * Avoids hammering /plan-review during freeze when Spec is not sealed yet.
 */
export function shouldLoadPlanReview(snapshot: {
  gates: readonly WikiRunGate[];
  nodes: readonly { key: string; kind: string; state: string }[];
} | null | undefined): boolean {
  if (!snapshot) return false;
  if (openPlanGateFromSnapshot(snapshot.gates)) return true;
  const planNode = snapshot.nodes.find((node) => node.key === "plan" || node.kind === "plan");
  if (!planNode) return false;
  return ["succeeded", "waiting", "running"].includes(planNode.state);
}

/** Effective stop reason from plan-review materials (top-level or nested coverage). */
export function coverageStopReasonOf(
  review: Pick<WikiRunPlanReview, "coverage" | "coverageStopReason"> | null | undefined,
): CoverageStopReason | undefined {
  if (!review) return undefined;
  return review.coverageStopReason ?? review.coverage?.stop_reason;
}

/**
 * Host fail-closed mirror: block Approve when coverage is incomplete / has gaps.
 * Missing coverage or `not_required` (light single-repo) must allow approve.
 */
export function coverageBlocksApprove(
  review: Pick<WikiRunPlanReview, "coverage" | "coverageStopReason"> | null | undefined,
): boolean {
  if (!review) return false;
  const stop = coverageStopReasonOf(review);
  if (stop === "coverage_gap") return true;
  const coverage = review.coverage;
  if (!coverage) return false;
  if (coverage.stop_reason === "not_required") return false;
  if (coverage.ok === false) return true;
  if (coverage.gaps.length > 0) return true;
  if (coverage.rows.some((row) => row.status === "gap")) return true;
  return false;
}

export type CoverageStatusCounts = {
  covered: number;
  gap: number;
  cancelled: number;
  total: number;
};

export function coverageStatusCounts(
  coverage: CoverageResult | null | undefined,
): CoverageStatusCounts {
  const counts: CoverageStatusCounts = { covered: 0, gap: 0, cancelled: 0, total: 0 };
  if (!coverage) return counts;
  for (const row of coverage.rows) {
    counts.total += 1;
    if (row.status === "covered") counts.covered += 1;
    else if (row.status === "gap") counts.gap += 1;
    else if (row.status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

const STATUS_ORDER: Record<CoverageRowStatus, number> = {
  gap: 0,
  covered: 1,
  cancelled: 2,
};

/**
 * Sort coverage rows for operator scan:
 * gaps first, then covered, then cancelled; within status prefer sources when
 * multi-source (source units present), else surfaces first for large-single.
 */
export function sortCoverageRows(rows: readonly CoverageResultRow[]): CoverageResultRow[] {
  const hasSource = rows.some((row) => row.kind === "source");
  const kindRank = (kind: CoverageResultRow["kind"]): number => {
    if (hasSource) return kind === "source" ? 0 : 1;
    return kind === "surface" ? 0 : 1;
  };
  return rows.slice().sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    const kindDiff = kindRank(a.kind) - kindRank(b.kind);
    if (kindDiff !== 0) return kindDiff;
    return a.unitId.localeCompare(b.unitId);
  });
}

/** Whether page-set diff has anything operator-visible (added/removed). */
export function pageSetDiffHasChanges(
  diff: WikiRunPlanReview["pageSetDiff"] | null | undefined,
): boolean {
  if (!diff) return false;
  return diff.added.length > 0 || diff.removed.length > 0;
}

/** Whether scouts summary has anything to show. */
export function hasScoutsSummary(
  scouts: WikiRunPlanReview["scoutsSummary"] | null | undefined,
): boolean {
  if (!scouts) return false;
  return scouts.receiptCount > 0 || scouts.kinds.length > 0;
}

/**
 * Soft discovery-map counts for plan-gate review.
 * Schema may not project these yet — never throws; returns null when absent.
 */
export type SoftDiscoverySummary = {
  domains: number;
  flows: number;
  concepts: number;
  sources?: number;
  openQuestions?: number;
};

function nonNegInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const n = Number(value);
    if (n >= 0) return Math.floor(n);
  }
  return undefined;
}

function countFromArrayOrNumber(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  return nonNegInt(value);
}

/**
 * Soft-read discovery domain/flow/concept counts from plan-review payload.
 * Prefer formal {@link WikiRunPlanReview.discoverySummary} count fields;
 * still accepts legacy soft shapes (full DiscoveryMap arrays / aliases).
 * Never hard-fails on unknown shapes.
 */
export function softDiscoverySummary(
  review: unknown,
): SoftDiscoverySummary | null {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const root = review as Record<string, unknown>;

  const blocks: unknown[] = [
    // Formal schema field (host-projected counts).
    root.discoverySummary,
    // Legacy soft aliases / full map embedding.
    root.discovery,
    root.discoveryMap,
    // Nested under artifact / extras if host soft-projects later.
    typeof root.artifact === "object" && root.artifact && !Array.isArray(root.artifact)
      ? (root.artifact as Record<string, unknown>).discoverySummary
      : undefined,
  ];

  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    const domains =
      nonNegInt(b.domainCount) ??
      nonNegInt(b.domain_count) ??
      countFromArrayOrNumber(b.domains);
    const flows =
      nonNegInt(b.flowCount) ?? nonNegInt(b.flow_count) ?? countFromArrayOrNumber(b.flows);
    const concepts =
      nonNegInt(b.conceptCount) ??
      nonNegInt(b.concept_count) ??
      countFromArrayOrNumber(b.concepts);
    if (domains === undefined && flows === undefined && concepts === undefined) continue;
    const sources =
      nonNegInt(b.sourceCount) ??
      nonNegInt(b.source_count) ??
      countFromArrayOrNumber(b.sources);
    const openQuestions =
      nonNegInt(b.openQuestionCount) ??
      nonNegInt(b.open_question_count) ??
      countFromArrayOrNumber(b.openQuestions);
    return {
      domains: domains ?? 0,
      flows: flows ?? 0,
      concepts: concepts ?? 0,
      ...(sources !== undefined ? { sources } : {}),
      ...(openQuestions !== undefined ? { openQuestions } : {}),
    };
  }

  return null;
}

export function hasDiscoverySummary(
  summary: SoftDiscoverySummary | null | undefined,
): boolean {
  if (!summary) return false;
  return (
    summary.domains > 0 ||
    summary.flows > 0 ||
    summary.concepts > 0 ||
    (summary.sources ?? 0) > 0
  );
}
