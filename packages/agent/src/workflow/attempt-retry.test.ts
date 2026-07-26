/**
 * Classifier + retry executor tests (pure; no Pi, no FS).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAttemptWithRetry } from "./attempt-retry.js";
import { classifyAgentFailure } from "./retry-policy.js";

describe("classifyAgentFailure", () => {
  it("recognizes transient transport failures", () => {
    assert.equal(classifyAgentFailure("429 Too Many Requests"), "transient");
    assert.equal(classifyAgentFailure("upstream rate limit exceeded"), "transient");
    assert.equal(classifyAgentFailure("request timed out after 120s"), "transient");
    assert.equal(classifyAgentFailure("connect ECONNRESET"), "transient");
    assert.equal(classifyAgentFailure("fetch failed"), "transient");
    assert.equal(classifyAgentFailure("503 Service Unavailable"), "transient");
    assert.equal(classifyAgentFailure("provider overloaded"), "transient");
  });

  it("recognizes budget exhaustion", () => {
    assert.equal(classifyAgentFailure("run token budget exhausted"), "budget");
  });

  it("leaves unknown failures unclassified", () => {
    assert.equal(classifyAgentFailure("boom domain"), undefined);
    assert.equal(classifyAgentFailure(""), undefined);
    assert.equal(classifyAgentFailure(undefined), undefined);
  });
});

describe("runAttemptWithRetry", () => {
  it("retries a transient failure once then succeeds", async () => {
    let calls = 0;
    const retries: number[] = [];
    const result = await runAttemptWithRetry({
      maxAttempts: 2,
      onRetry: ({ attemptIndex }) => retries.push(attemptIndex),
      run: async (attemptIndex) => {
        calls += 1;
        if (attemptIndex === 0) throw new Error("429 rate limit");
        return "ok";
      },
    });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
    assert.deepEqual(retries, [0]);
  });

  it("throws the last error when attempts are exhausted", async () => {
    let calls = 0;
    await assert.rejects(
      runAttemptWithRetry({
        maxAttempts: 2,
        run: async () => {
          calls += 1;
          throw new Error("boom domain");
        },
      }),
      /boom domain/,
    );
    // Unknown class gets the policy retry, then exhausts.
    assert.equal(calls, 2);
  });

  it("does not retry budget failures", async () => {
    let calls = 0;
    await assert.rejects(
      runAttemptWithRetry({
        maxAttempts: 3,
        run: async () => {
          calls += 1;
          throw new Error("token budget exhausted");
        },
      }),
      /budget/,
    );
    assert.equal(calls, 1);
  });

  it("rethrows AbortError immediately without retry", async () => {
    let calls = 0;
    await assert.rejects(
      runAttemptWithRetry({
        maxAttempts: 3,
        run: async () => {
          calls += 1;
          const err = new Error("Wiki Run cancelled");
          err.name = "AbortError";
          throw err;
        },
      }),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
    assert.equal(calls, 1);
  });
});
