/**
 * WikiRuns scheduler concurrency from workspace.orchestration (Settings).
 *
 * Pre-SQLite produce ran domain units under domainConcurrency and review seats
 * under reviewConcurrency. Definition v1 makes each leaf/domain/seat a durable
 * node; the scheduler must re-apply the same budgets when claiming ready work.
 */

import {
  DEFAULT_ORCHESTRATION,
  type WorkspaceConfig,
  type WorkspaceOrchestration,
} from "@okf-wiki/contract";
import { isMechanicalAttemptKind } from "../definition-v1.js";

/** Pre-WikiRuns leaf parallel width inside one domain unit (research-phase). */
const LEGACY_LEAF_PARALLEL = 2;

/**
 * Resolve orchestration with schema defaults (workspace may omit optional keys).
 */
export function resolveSchedulerOrchestration(
  workspace: WorkspaceConfig | null | undefined,
): WorkspaceOrchestration {
  const o = workspace?.orchestration;
  if (!o) return { ...DEFAULT_ORCHESTRATION };
  const reviewCouncilSize = o.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize;
  const planScoutCount = o.planScoutCount ?? DEFAULT_ORCHESTRATION.planScoutCount;
  return {
    maxDepth: o.maxDepth ?? DEFAULT_ORCHESTRATION.maxDepth,
    maxDomainFanOut: o.maxDomainFanOut ?? DEFAULT_ORCHESTRATION.maxDomainFanOut,
    maxLeafFanOut: o.maxLeafFanOut ?? DEFAULT_ORCHESTRATION.maxLeafFanOut,
    reviewCouncilSize,
    ...(o.reviewConcurrency !== undefined ? { reviewConcurrency: o.reviewConcurrency } : {}),
    planScoutCount,
    ...(o.planScoutConcurrency !== undefined
      ? { planScoutConcurrency: o.planScoutConcurrency }
      : {}),
    domainConcurrency: o.domainConcurrency ?? DEFAULT_ORCHESTRATION.domainConcurrency,
  };
}

/**
 * Max concurrent in-flight Attempts for a node kind.
 *
 * - research.leaf: domainConcurrency × min(2, maxLeafFanOut) so multi-domain
 *   leaves share one pool (matches pre-SQLite domain units × leaf parallel).
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
  const maxLeafFanOut = Math.max(1, orch.maxLeafFanOut);
  const reviewCouncilSize = Math.max(1, orch.reviewCouncilSize);
  const reviewConcurrency = Math.max(
    1,
    Math.min(reviewCouncilSize, orch.reviewConcurrency ?? reviewCouncilSize),
  );

  switch (kind) {
    case "research.leaf":
      return domainConcurrency * Math.min(LEGACY_LEAF_PARALLEL, maxLeafFanOut);
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
