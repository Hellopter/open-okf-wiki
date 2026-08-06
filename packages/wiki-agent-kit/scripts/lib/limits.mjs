/**
 * Pure concurrency / pass-budget helpers for run-policy limits.
 */

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * @param {{ sourceCount?: number }} [opts]
 */
export function defaultLimits({ sourceCount } = {}) {
  const multi = Number(sourceCount) >= 2;
  return {
    batchConcurrency: multi ? 3 : 4,
    perSourceConcurrency: 2,
    maxCoveragePasses: 2,
    maxRepairRounds: 2,
  };
}

/**
 * @param {unknown} raw
 * @param {{ sourceCount?: number }} [opts]
 */
export function normalizeLimits(raw, { sourceCount } = {}) {
  const defaults = defaultLimits({ sourceCount });
  const input = raw && typeof raw === "object" ? raw : {};
  const batchConcurrency = clampInt(input.batchConcurrency, 1, 8, defaults.batchConcurrency);
  const perSourceConcurrency = clampInt(
    input.perSourceConcurrency,
    1,
    batchConcurrency,
    Math.min(defaults.perSourceConcurrency, batchConcurrency),
  );
  const maxCoveragePasses = clampInt(input.maxCoveragePasses, 1, 4, defaults.maxCoveragePasses);
  const maxRepairRounds = clampInt(input.maxRepairRounds, 1, 4, defaults.maxRepairRounds);
  return {
    batchConcurrency,
    perSourceConcurrency,
    maxCoveragePasses,
    maxRepairRounds,
  };
}
