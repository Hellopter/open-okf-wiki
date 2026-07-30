/**
 * Phase 7 economy metrics: source-read overlap, receipt size, Writer fallback,
 * reviewer unique defect yield.
 *
 * Stored under AttemptMetrics.extra (catch-all) so contract schema stays stable.
 * Dashboards / operators read via snapshot attempt.metrics.extra.
 */

import type { AttemptMetrics } from "@okf-wiki/contract";

/** Keys under AttemptMetrics.extra for economy observation. */
export const ECONOMY_METRIC_KEYS = {
  sourceReadPaths: "sourceReadPaths",
  sourceReadOverlap: "sourceReadOverlap",
  receiptBytes: "receiptBytes",
  writerFallbackSearch: "writerFallbackSearch",
  uniqueDefectYield: "uniqueDefectYield",
  sourceMountMode: "sourceMountMode",
} as const;

export type EconomyMetricKey = (typeof ECONOMY_METRIC_KEYS)[keyof typeof ECONOMY_METRIC_KEYS];

export type SourceReadOverlap = {
  /** Jaccard-ish overlap [0,1] across worker source-read path sets. */
  overlap: number;
  /** Number of worker attempts compared. */
  workerCount: number;
  /** Paths read by ≥2 workers. */
  sharedPathCount: number;
  /** Union of all source paths read. */
  unionPathCount: number;
};

export type UniqueDefectYield = {
  /** Defects seen by only one seat. */
  uniqueCount: number;
  /** Defects seen by ≥2 seats. */
  sharedCount: number;
  /** Total distinct defect ids/messages after normalize. */
  totalDistinct: number;
  /** uniqueCount / totalDistinct when total > 0. */
  uniqueRatio: number;
};

/**
 * Compute pairwise path-set overlap across workers (source-read orientation cost).
 * High overlap → merge signal, not more fan-out.
 */
export function computeSourceReadOverlap(
  pathSets: readonly ReadonlySet<string>[],
): SourceReadOverlap {
  const workers = pathSets.filter((s) => s.size > 0);
  if (workers.length === 0) {
    return { overlap: 0, workerCount: 0, sharedPathCount: 0, unionPathCount: 0 };
  }
  const counts = new Map<string, number>();
  for (const set of workers) {
    for (const p of set) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const unionPathCount = counts.size;
  let sharedPathCount = 0;
  for (const n of counts.values()) {
    if (n >= 2) sharedPathCount += 1;
  }
  const overlap = unionPathCount === 0 ? 0 : sharedPathCount / unionPathCount;
  return {
    overlap,
    workerCount: workers.length,
    sharedPathCount,
    unionPathCount,
  };
}

/**
 * Unique defect yield across review seats.
 * High uniqueRatio → extra lenses paid for; low → light path enough.
 */
export function computeUniqueDefectYield(
  seatDefectIds: ReadonlyArray<ReadonlyArray<string>>,
): UniqueDefectYield {
  const counts = new Map<string, number>();
  for (const seat of seatDefectIds) {
    const seen = new Set<string>();
    for (const raw of seat) {
      const id = normalizeDefectId(raw);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let uniqueCount = 0;
  let sharedCount = 0;
  for (const n of counts.values()) {
    if (n === 1) uniqueCount += 1;
    else sharedCount += 1;
  }
  const totalDistinct = counts.size;
  return {
    uniqueCount,
    sharedCount,
    totalDistinct,
    uniqueRatio: totalDistinct === 0 ? 0 : uniqueCount / totalDistinct,
  };
}

function normalizeDefectId(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
}

/** Attach economy fields into metrics.extra without clobbering other extras. */
export function withEconomyMetrics(
  metrics: AttemptMetrics | undefined,
  economy: Partial<Record<EconomyMetricKey, unknown>>,
): AttemptMetrics {
  const base = { ...(metrics ?? {}) };
  const extra = { ...(base.extra ?? {}) };
  for (const [k, v] of Object.entries(economy)) {
    if (v !== undefined) extra[k] = v;
  }
  base.extra = extra;
  return base;
}

/** Summarize run-level economy for dashboards (from attempt extras). */
export function summarizeRunEconomy(attempts: readonly { metrics?: AttemptMetrics }[]): {
  sourceReadOverlap?: number;
  receiptBytesTotal: number;
  writerFallbackSearchCount: number;
  uniqueDefectYield?: number;
  hardlinkMounts: number;
  copyMounts: number;
} {
  let receiptBytesTotal = 0;
  let writerFallbackSearchCount = 0;
  let hardlinkMounts = 0;
  let copyMounts = 0;
  let lastOverlap: number | undefined;
  let lastYield: number | undefined;

  for (const a of attempts) {
    const extra = a.metrics?.extra;
    if (!extra || typeof extra !== "object") continue;
    const bytes = extra[ECONOMY_METRIC_KEYS.receiptBytes];
    if (typeof bytes === "number" && Number.isFinite(bytes)) receiptBytesTotal += bytes;
    if (extra[ECONOMY_METRIC_KEYS.writerFallbackSearch] === true) {
      writerFallbackSearchCount += 1;
    }
    const mode = extra[ECONOMY_METRIC_KEYS.sourceMountMode];
    if (mode === "hardlink") hardlinkMounts += 1;
    if (mode === "copy") copyMounts += 1;
    const overlap = extra[ECONOMY_METRIC_KEYS.sourceReadOverlap];
    if (typeof overlap === "number" && Number.isFinite(overlap)) lastOverlap = overlap;
    const yieldRatio = extra[ECONOMY_METRIC_KEYS.uniqueDefectYield];
    if (typeof yieldRatio === "number" && Number.isFinite(yieldRatio)) lastYield = yieldRatio;
  }

  return {
    ...(lastOverlap !== undefined ? { sourceReadOverlap: lastOverlap } : {}),
    receiptBytesTotal,
    writerFallbackSearchCount,
    ...(lastYield !== undefined ? { uniqueDefectYield: lastYield } : {}),
    hardlinkMounts,
    copyMounts,
  };
}
