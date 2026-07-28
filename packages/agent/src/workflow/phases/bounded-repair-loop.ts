/**
 * Shared bounded repair loop for review-council and hard-validate phases.
 *
 * Callers pass independent budget counters (`budgetKey`) so council and
 * mechanical hard-validate do not share one repair allotment.
 */

import type { ProduceWikiResult } from "./types.js";

export type RepairScore =
  | { kind: "pass" }
  | { kind: "fail_closed"; result: ProduceWikiResult }
  | { kind: "cancelled"; result: ProduceWikiResult }
  | { kind: "repair"; repairText: string };

export type RepairActionResult =
  | { kind: "ok" }
  | { kind: "cancelled"; result: ProduceWikiResult };

export type BoundedRepairLoopResult =
  | { kind: "passed" }
  | { kind: "exhausted" }
  | { kind: "cancelled"; result: ProduceWikiResult }
  | { kind: "failed"; result: ProduceWikiResult };

/**
 * Try to spend one repair round on `metrics[budgetKey]`. Returns false when
 * budget is already exhausted (does not increment). On success, increments the
 * named counter (1-based count of completed repair attempts after return).
 */
export function consumeRepairBudget<K extends string>(
  metrics: Record<K, number>,
  budgetKey: K,
  maxRepair: number,
): boolean {
  if (metrics[budgetKey] >= maxRepair) return false;
  metrics[budgetKey] += 1;
  return true;
}

/**
 * Score-first bounded repair:
 * 1. score()
 * 2. pass → done; fail_closed / cancelled → terminal; repair → try budget
 * 3. if budget remains, repair then loop; else exhausted
 *
 * `round` is 1-based score attempt count (council uses it as review run index + 1).
 *
 * ## Abort / budget ordering invariant
 *
 * Budget is consumed **only after** `score` returns `{ kind: "repair" }`
 * (see `consumeRepairBudget` below). Callers that must not spend a repair
 * round on cancellation **MUST** abort inside `score` *before* returning
 * `{ kind: "repair" }` — e.g. `throwIfAborted(signal)` or
 * `return { kind: "cancelled", result }` prior to the repair branch.
 *
 * Returning `{ kind: "repair" }` first and aborting later (in `repair` or
 * `onBeforeRepair`) still increments the budget counter named by `budgetKey`.
 */
export async function runBoundedRepairLoop<K extends string>(input: {
  maxRepair: number;
  metrics: Record<K, number>;
  /** Which metrics field this loop spends (council vs hard-validate). */
  budgetKey: K;
  score: (ctx: { round: number }) => Promise<RepairScore>;
  repair: (repairText: string) => Promise<RepairActionResult>;
  onBeforeRepair?: (ctx: {
    repairRound: number;
    repairText: string;
    round: number;
  }) => void | Promise<void>;
}): Promise<BoundedRepairLoopResult> {
  let round = 0;
  for (;;) {
    round += 1;
    const scored = await input.score({ round });
    if (scored.kind === "pass") return { kind: "passed" };
    if (scored.kind === "fail_closed") {
      return { kind: "failed", result: scored.result };
    }
    if (scored.kind === "cancelled") {
      return { kind: "cancelled", result: scored.result };
    }

    if (!consumeRepairBudget(input.metrics, input.budgetKey, input.maxRepair)) {
      return { kind: "exhausted" };
    }

    await input.onBeforeRepair?.({
      repairRound: input.metrics[input.budgetKey],
      repairText: scored.repairText,
      round,
    });

    const repaired = await input.repair(scored.repairText);
    if (repaired.kind === "cancelled") {
      return { kind: "cancelled", result: repaired.result };
    }
  }
}
