/**
 * Product bounds for supervisor-tree Wiki Runs.
 * Prefer workspace.orchestration when present; these are fallbacks.
 *
 * Fan-out / depth / council size are enforced in produce orchestration.
 * Pi AgentSession has no maxSteps API — turn limits use abort/timeout only.
 */

import {
  DEFAULT_ORCHESTRATION as CONTRACT_DEFAULT_ORCHESTRATION,
  type WorkspaceConfig,
  type WorkspaceOrchestration,
} from "@okf-wiki/contract";

/** Schema defaults from `@okf-wiki/contract` are the sole authority. */
export const DEFAULT_ORCHESTRATION: WorkspaceOrchestration = {
  ...CONTRACT_DEFAULT_ORCHESTRATION,
};

/**
 * Wall-clock budget for one child agent session, from workspace limits.
 * Undefined when the operator has not set requestTimeoutSeconds — callers
 * then run without a per-session timeout (abort signal still applies).
 */
export function requestTimeoutMs(workspace?: WorkspaceConfig | null): number | undefined {
  const seconds = workspace?.limits?.requestTimeoutSeconds;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

export function resolveOrchestration(workspace?: WorkspaceConfig | null): WorkspaceOrchestration {
  const o = workspace?.orchestration;
  if (!o) {
    return { ...DEFAULT_ORCHESTRATION };
  }
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
