/**
 * Derive Pi compaction settings from product context budgets.
 *
 * Product model:
 * - `maxContextTokens` — provider hard window (model profile)
 * - `contextTargetTokens` — operational budget for Wiki Run (workspace.limits)
 *   When unset, default is 85% of maxContextTokens.
 *
 * Pi auto-compacts when:
 *   contextTokens > contextWindow - reserveTokens
 *
 * So we set reserveTokens = contextWindow - contextTarget so compaction
 * fires as usage approaches the operational target.
 */

export type ContextBudgetInput = {
  /** Provider hard window from model profile. */
  maxContextTokens?: number;
  /** Workspace operational target (tokens). */
  contextTargetTokens?: number;
  /** Fallback window when profile has no max. */
  defaultWindow?: number;
};

export type ContextBudget = {
  /** Hard window applied to the Pi Model.contextWindow. */
  contextWindow: number;
  /** Operational target used for compaction trigger. */
  contextTarget: number;
  /** Pi Settings.compaction.reserveTokens */
  reserveTokens: number;
  /** Pi Settings.compaction.keepRecentTokens */
  keepRecentTokens: number;
  /** Fraction of window used as target when contextTargetTokens unset. */
  targetRatio: number;
};

const DEFAULT_WINDOW = 128_000;
const TARGET_RATIO = 0.85;
const MIN_RESERVE = 2_048;
const MIN_KEEP_RECENT = 4_096;
const DEFAULT_KEEP_RECENT = 20_000;

/**
 * Resolve context window + compaction reserve from product limits.
 */
export function resolveContextBudget(input: ContextBudgetInput = {}): ContextBudget {
  const contextWindow = Math.max(
    4_096,
    input.maxContextTokens ?? input.defaultWindow ?? DEFAULT_WINDOW,
  );

  let contextTarget: number;
  if (
    typeof input.contextTargetTokens === "number" &&
    Number.isFinite(input.contextTargetTokens) &&
    input.contextTargetTokens > 0
  ) {
    contextTarget = Math.min(contextWindow - MIN_RESERVE, Math.floor(input.contextTargetTokens));
  } else {
    contextTarget = Math.floor(contextWindow * TARGET_RATIO);
  }
  // Keep target strictly below window so reserve is positive.
  contextTarget = Math.max(MIN_RESERVE, Math.min(contextTarget, contextWindow - MIN_RESERVE));

  const reserveTokens = Math.max(MIN_RESERVE, contextWindow - contextTarget);
  const keepRecentTokens = Math.max(
    MIN_KEEP_RECENT,
    Math.min(DEFAULT_KEEP_RECENT, Math.floor(contextTarget * 0.25)),
  );

  return {
    contextWindow,
    contextTarget,
    reserveTokens,
    keepRecentTokens,
    targetRatio: TARGET_RATIO,
  };
}

/**
 * Seat-level budget: clamp profile max against the live model window.
 * Never advertise a window larger than the model when the model window is known.
 */
export function resolveSeatContextBudget(input: {
  maxContextTokens?: number;
  modelContextWindow?: number;
  contextTargetTokens?: number;
  defaultWindow?: number;
}): ContextBudget {
  const modelWin =
    typeof input.modelContextWindow === "number" && input.modelContextWindow > 0
      ? input.modelContextWindow
      : undefined;
  const profileMax =
    typeof input.maxContextTokens === "number" && input.maxContextTokens > 0
      ? input.maxContextTokens
      : undefined;
  // effectiveWindow = min(profile, model) when both set; never > model window when model known
  let maxContextTokens: number | undefined;
  if (profileMax !== undefined && modelWin !== undefined) {
    maxContextTokens = Math.min(profileMax, modelWin);
  } else {
    maxContextTokens = profileMax ?? modelWin;
  }
  return resolveContextBudget({
    maxContextTokens,
    contextTargetTokens: input.contextTargetTokens,
    defaultWindow: input.defaultWindow,
  });
}

/** Pi Settings.compaction slice from a budget. */
export function compactionSettingsFromBudget(budget: ContextBudget): {
  enabled: true;
  reserveTokens: number;
  keepRecentTokens: number;
} {
  return {
    enabled: true,
    reserveTokens: budget.reserveTokens,
    keepRecentTokens: budget.keepRecentTokens,
  };
}
