/**
 * Unit tests for bounded repair loop budget + abort ordering.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  consumeRepairBudget,
  runBoundedRepairLoop,
  type RepairScore,
} from "./bounded-repair-loop.js";
import type { ProduceWikiResult } from "./types.js";

function cancelledStub(): ProduceWikiResult {
  return {
    status: "cancelled",
    pages: [],
    summary: "Wiki Run cancelled",
    spec: defaultWikiRunSpec("test"),
    defects: null,
    publishability: { publishable: false, reasons: ["cancelled"], pages: [], defects: null },
    layout: {
      runWorkDir: "/tmp",
      sourcesDir: "/tmp/s",
      skillDir: "/tmp/k",
      wikiDir: "/tmp/w",
      analysisDir: "/tmp/a",
      sourceMounts: new Map(),
    },
    mode: "fixture",
    metrics: {
      domainStarts: 0,
      leafStarts: 0,
      repairRounds: 0,
      hardValidateRepairRounds: 0,
    },
  };
}

describe("consumeRepairBudget", () => {
  it("increments until max, then returns false without further increment", () => {
    const metrics = { repairRounds: 0 };
    assert.equal(consumeRepairBudget(metrics, "repairRounds", 2), true);
    assert.equal(metrics.repairRounds, 1);
    assert.equal(consumeRepairBudget(metrics, "repairRounds", 2), true);
    assert.equal(metrics.repairRounds, 2);
    assert.equal(consumeRepairBudget(metrics, "repairRounds", 2), false);
    assert.equal(metrics.repairRounds, 2);
  });

  it("tracks independent budget keys without cross-spend", () => {
    const metrics = { repairRounds: 0, hardValidateRepairRounds: 0 };
    assert.equal(consumeRepairBudget(metrics, "repairRounds", 1), true);
    assert.equal(metrics.repairRounds, 1);
    assert.equal(metrics.hardValidateRepairRounds, 0);
    assert.equal(consumeRepairBudget(metrics, "hardValidateRepairRounds", 2), true);
    assert.equal(metrics.repairRounds, 1);
    assert.equal(metrics.hardValidateRepairRounds, 1);
    assert.equal(consumeRepairBudget(metrics, "repairRounds", 1), false);
    assert.equal(consumeRepairBudget(metrics, "hardValidateRepairRounds", 2), true);
    assert.equal(metrics.hardValidateRepairRounds, 2);
  });
});

describe("runBoundedRepairLoop abort-before-repair ordering", () => {
  it("does not consume budget when score aborts before returning repair", async () => {
    const metrics = { repairRounds: 0 };
    await assert.rejects(
      () =>
        runBoundedRepairLoop({
          maxRepair: 2,
          metrics,
          budgetKey: "repairRounds",
          score: async () => {
            // Ordering invariant: abort inside score BEFORE kind:'repair'.
            const err = new Error("Wiki Run cancelled");
            err.name = "AbortError";
            throw err;
          },
          repair: async () => {
            assert.fail("repair must not run when score aborts");
            return { kind: "ok" };
          },
        }),
      (e: unknown) => e instanceof Error && e.name === "AbortError",
    );
    assert.equal(metrics.repairRounds, 0, "abort before repair must not spend budget");
  });

  it("does not consume budget when score returns cancelled", async () => {
    const metrics = { repairRounds: 0 };
    const result = await runBoundedRepairLoop({
      maxRepair: 2,
      metrics,
      budgetKey: "repairRounds",
      score: async () => ({ kind: "cancelled", result: cancelledStub() }),
      repair: async () => {
        assert.fail("repair must not run on cancelled score");
        return { kind: "ok" };
      },
    });
    assert.equal(result.kind, "cancelled");
    assert.equal(metrics.repairRounds, 0);
  });

  it("consumes budget only after score returns repair", async () => {
    const metrics = { repairRounds: 0 };
    let scores = 0;
    const outcome = await runBoundedRepairLoop({
      maxRepair: 1,
      metrics,
      budgetKey: "repairRounds",
      score: async (): Promise<RepairScore> => {
        scores += 1;
        if (scores === 1) return { kind: "repair", repairText: "fix me" };
        return { kind: "pass" };
      },
      repair: async () => {
        assert.equal(metrics.repairRounds, 1, "budget already consumed when repair runs");
        return { kind: "ok" };
      },
    });
    assert.equal(outcome.kind, "passed");
    assert.equal(metrics.repairRounds, 1);
    assert.equal(scores, 2);
  });

  it("spends only the named budgetKey", async () => {
    const metrics = { repairRounds: 0, hardValidateRepairRounds: 0 };
    let scores = 0;
    const outcome = await runBoundedRepairLoop({
      maxRepair: 1,
      metrics,
      budgetKey: "hardValidateRepairRounds",
      score: async (): Promise<RepairScore> => {
        scores += 1;
        if (scores === 1) return { kind: "repair", repairText: "hv fix" };
        return { kind: "pass" };
      },
      repair: async () => ({ kind: "ok" }),
    });
    assert.equal(outcome.kind, "passed");
    assert.equal(metrics.hardValidateRepairRounds, 1);
    assert.equal(metrics.repairRounds, 0);
  });
});
