/**
 * Pure plan-review helpers (no React / network). Safe for node:test.
 */

import type { WikiRunGate, WikiRunPlanReview } from "@okf-wiki/contract";

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
