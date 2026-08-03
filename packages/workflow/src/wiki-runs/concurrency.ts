/**
 * WikiRuns scheduler concurrency from workspace.orchestration (Settings).
 *
 * Pre-SQLite produce ran domain units under domainConcurrency and review seats
 * under reviewConcurrency. The execution graph makes each leaf/domain/seat a durable
 * node; the scheduler must re-apply the same budgets when claiming ready work.
 *
 * Execution graph topology caps are maxDomainFanOut / maxLeafFanOut only.
 */

import { resolveOrchestration, type WorkspaceConfig, type WorkspaceOrchestration } from "@okf-wiki/contract/workspace";
import { isMechanicalAttemptKind } from "../execution-graph.js";

/**
 * Resolve orchestration with schema defaults (workspace may omit optional keys).
 * Thin workspace wrapper over the single canonical resolveOrchestration in
 * @okf-wiki/contract — do not reimplement defaults here.
 */
export function resolveSchedulerOrchestration(
  workspace: WorkspaceConfig | null | undefined,
): WorkspaceOrchestration {
  return resolveOrchestration(workspace?.orchestration);
}

/**
 * Max concurrent in-flight Attempts for a node kind.
 *
 * - research.leaf: domainConcurrency × min(leafConcurrency, maxLeafFanOut) so
 *   multi-domain leaves share one pool. maxLeafFanOut is topology only (how many
 *   leaf nodes the graph materializes per domain); leafConcurrency is per-domain
 *   parallel width. Raise domainConcurrency for more parallel domains; raise
 *   leafConcurrency for more leaves in-flight per domain; raise maxLeafFanOut
 *   only to allow more questions per domain.
 * - research.domain: domainConcurrency
 * - review.seat: reviewConcurrency (default council size)
 * - single-pipeline Pi (plan/write/repair): 1
 * - mechanical (validate/publish/…): unbounded (local, fast)
 */
export function concurrencyLimitForKind(
  workspace: WorkspaceConfig | null | undefined,
  kind: string,
): number {
  const orch = resolveSchedulerOrchestration(workspace);
  const domainConcurrency = Math.max(1, orch.domainConcurrency);
  const leafConcurrency = Math.max(1, orch.leafConcurrency);
  const maxLeafFanOut = Math.max(1, orch.maxLeafFanOut);
  const reviewCouncilSize = Math.max(1, orch.reviewCouncilSize);
  const reviewConcurrency = Math.max(
    1,
    Math.min(reviewCouncilSize, orch.reviewConcurrency ?? reviewCouncilSize),
  );

  switch (kind) {
    case "research.leaf":
      return domainConcurrency * Math.min(leafConcurrency, maxLeafFanOut);
    case "research.domain":
      return domainConcurrency;
    case "review.seat":
      return reviewConcurrency;
    case "freeze":
    case "plan":
    case "write.root":
    case "repair":
      return 1;
    default:
      if (isMechanicalAttemptKind(kind)) return Number.POSITIVE_INFINITY;
      return 1;
  }
}

/**
 * Whether another Attempt of `kind` may be claimed given currently running counts.
 * `runningByKind` is counted from in-process activeAttempts (or DB running nodes).
 */
export function canClaimKind(
  workspace: WorkspaceConfig | null | undefined,
  kind: string,
  runningByKind: ReadonlyMap<string, number> | Record<string, number>,
): boolean {
  const limit = concurrencyLimitForKind(workspace, kind);
  if (!Number.isFinite(limit)) return true;
  const running =
    runningByKind instanceof Map
      ? (runningByKind.get(kind) ?? 0)
      : ((runningByKind as Record<string, number>)[kind] ?? 0);
  return running < limit;
}
