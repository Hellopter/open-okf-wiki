/**
 * Phase 7 economy metrics: overlap / yield / receipt size / writer fallback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSourceReadOverlap,
  computeUniqueDefectYield,
  summarizeRunEconomy,
  withEconomyMetrics,
} from "./run-economy-metrics.js";

test("computeSourceReadOverlap: high shared paths → high overlap", () => {
  const a = new Set(["sources/a/README.md", "sources/a/src/main.ts"]);
  const b = new Set(["sources/a/README.md", "sources/a/src/util.ts"]);
  const r = computeSourceReadOverlap([a, b]);
  assert.equal(r.workerCount, 2);
  assert.equal(r.sharedPathCount, 1);
  assert.equal(r.unionPathCount, 3);
  assert.ok(Math.abs(r.overlap - 1 / 3) < 1e-9);
});

test("computeSourceReadOverlap: empty workers → zero", () => {
  const r = computeSourceReadOverlap([new Set(), new Set()]);
  assert.equal(r.overlap, 0);
  assert.equal(r.workerCount, 0);
});

test("computeUniqueDefectYield: unique vs shared", () => {
  const r = computeUniqueDefectYield([
    ["Missing citation on overview", "Broken link"],
    ["Missing citation on overview", "Tone inconsistency"],
  ]);
  assert.equal(r.uniqueCount, 2); // Broken link + Tone
  assert.equal(r.sharedCount, 1); // Missing citation
  assert.equal(r.totalDistinct, 3);
  assert.ok(Math.abs(r.uniqueRatio - 2 / 3) < 1e-9);
});

test("withEconomyMetrics merges extra without clobber", () => {
  const m = withEconomyMetrics(
    { role: "leaf", extra: { keep: true } },
    { receiptBytes: 128, writerFallbackSearch: false },
  );
  assert.equal(m.role, "leaf");
  assert.equal(m.extra?.keep, true);
  assert.equal(m.extra?.receiptBytes, 128);
  assert.equal(m.extra?.writerFallbackSearch, false);
});

test("summarizeRunEconomy aggregates attempt extras", () => {
  const summary = summarizeRunEconomy([
    {
      metrics: withEconomyMetrics(undefined, {
        receiptBytes: 100,
        sourceMountMode: "hardlink",
        sourceReadOverlap: 0.25,
      }),
    },
    {
      metrics: withEconomyMetrics(undefined, {
        receiptBytes: 50,
        writerFallbackSearch: true,
        sourceMountMode: "copy",
        uniqueDefectYield: 0.5,
      }),
    },
  ]);
  assert.equal(summary.receiptBytesTotal, 150);
  assert.equal(summary.writerFallbackSearchCount, 1);
  assert.equal(summary.hardlinkMounts, 1);
  assert.equal(summary.copyMounts, 1);
  assert.equal(summary.sourceReadOverlap, 0.25);
  assert.equal(summary.uniqueDefectYield, 0.5);
});
