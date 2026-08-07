import assert from "node:assert/strict";
import test from "node:test";
import { createTaskPool, withTimeout, TimeoutError } from "../dist/orch/pool.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("withTimeout resolves when promise finishes in time", async () => {
  const value = await withTimeout(Promise.resolve(42), 100);
  assert.equal(value, 42);
});

test("withTimeout rejects with TimeoutError and calls onTimeout", async () => {
  let timedOut = false;
  await assert.rejects(
    () =>
      withTimeout(
        delay(200),
        30,
        () => {
          timedOut = true;
        },
        "slow",
      ),
    (err) => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.timeoutMs, 30);
      assert.equal(err.label, "slow");
      return true;
    },
  );
  assert.equal(timedOut, true);
});

test("createTaskPool enforces concurrency limit", async () => {
  const pool = createTaskPool({ concurrency: 2 });
  let maxActive = 0;
  let current = 0;
  const tasks = [];

  for (let i = 0; i < 5; i++) {
    tasks.push(
      pool.run(async () => {
        current += 1;
        maxActive = Math.max(maxActive, current);
        await delay(40);
        current -= 1;
        return i;
      }),
    );
  }

  // While tasks are queued, stats should show bounded active count.
  await delay(10);
  const mid = pool.stats();
  assert.ok(mid.active <= 2, `active should be <= 2, got ${mid.active}`);
  assert.ok(mid.queued >= 1, "expected some queued work");

  const results = await Promise.all(tasks);
  assert.deepEqual(results.sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.ok(maxActive <= 2, `maxActive ${maxActive} exceeded concurrency`);
  assert.equal(pool.stats().completed, 5);
  assert.equal(pool.stats().active, 0);
  assert.equal(pool.stats().queued, 0);
  pool.dispose();
});

test("createTaskPool aborts signal on timeout", async () => {
  const pool = createTaskPool({ concurrency: 1 });
  let sawAbort = false;

  await assert.rejects(
    () =>
      pool.run(
        async (signal) => {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 500);
            signal.addEventListener("abort", () => {
              sawAbort = true;
              clearTimeout(t);
              reject(new Error("aborted"));
            });
          });
          return "done";
        },
        { timeoutMs: 40, label: "hang" },
      ),
    (err) => err instanceof TimeoutError || (err instanceof Error && err.message === "aborted"),
  );

  // Either TimeoutError wins the race, or abort rejection — both are acceptable.
  // Abort should have been requested.
  assert.equal(sawAbort, true);
  pool.dispose();
});

test("createTaskPool dispose rejects new work and aborts active", async () => {
  const pool = createTaskPool({ concurrency: 1 });
  let sawAbort = false;

  const hanging = pool.run(async (signal) => {
    signal.addEventListener("abort", () => {
      sawAbort = true;
    });
    // Cooperative hang — dispose must still reject the outer run() promise.
    await new Promise(() => {});
  });

  // Let the task become active, then dispose.
  await delay(5);
  pool.dispose();
  await assert.rejects(() => hanging, /disposed/i);
  assert.equal(sawAbort, true);
  await assert.rejects(() => pool.run(async () => 1), /disposed/i);
  assert.equal(pool.stats().disposed, true);
});
