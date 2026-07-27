/**
 * Bounded-parallel map tests (pure; no Pi, no FS).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapWithConcurrency } from "./map-with-concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves order under bounded concurrency", async () => {
    const items = [1, 2, 3, 4, 5];
    const active = { n: 0, max: 0 };
    const results = await mapWithConcurrency(items, 2, undefined, async (item) => {
      active.n += 1;
      active.max = Math.max(active.max, active.n);
      await new Promise((r) => setTimeout(r, 10));
      active.n -= 1;
      return item * 10;
    });
    assert.deepEqual(results, [10, 20, 30, 40, 50]);
    assert.ok(active.max <= 2);
  });

  it("stops scheduling new work after abort; in-flight continue", async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const finished: number[] = [];
    const items = [0, 1, 2, 3, 4, 5];

    const done = mapWithConcurrency(items, 2, ac.signal, async (item) => {
      started.push(item);
      if (started.length === 2) {
        // Abort after first wave is in flight — workers must not pick more.
        ac.abort();
      }
      await new Promise((r) => setTimeout(r, 20));
      finished.push(item);
      return item;
    });

    const results = await done;
    // Only the in-flight pair should have run; no further scheduling.
    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(finished, [0, 1]);
    assert.equal(results[0], 0);
    assert.equal(results[1], 1);
    assert.equal(results[2], undefined);
    assert.equal(results[5], undefined);
  });

  it("returns empty array for empty input", async () => {
    const results = await mapWithConcurrency([], 4, undefined, async () => 1);
    assert.deepEqual(results, []);
  });
});
