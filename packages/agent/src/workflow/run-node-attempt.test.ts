/**
 * Classifier + runNodeAttempt tests (pure; no Pi, no FS).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyAgentFailure } from "./retry-policy.js";
import { runNodeAttempt } from "./run-node-attempt.js";

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

describe("runNodeAttempt", () => {
  it("retries a transient failure once then succeeds", async () => {
    let calls = 0;
    const retries: number[] = [];
    const result = await runNodeAttempt({
      maxAttempts: 2,
      nodeKey: "domain-a",
      attemptId: (i) => (i === 0 ? "domain-a" : `domain-a@retry${i}`),
      onExhausted: "throw",
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

  it("throws the last error when attempts are exhausted (onExhausted: throw)", async () => {
    let calls = 0;
    await assert.rejects(
      runNodeAttempt({
        maxAttempts: 2,
        nodeKey: "domain-b",
        attemptId: (i) => `domain-b@${i}`,
        onExhausted: "throw",
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

  it("returns onExhausted fallback instead of throwing", async () => {
    let calls = 0;
    const result = await runNodeAttempt({
      maxAttempts: 2,
      nodeKey: "review",
      role: "reviewer",
      attemptId: (i) => (i === 0 ? "review@0:r1" : `review@0:r1~retry${i}`),
      onExhausted: (_err, { message }) => `fallback:${message}`,
      run: async () => {
        calls += 1;
        throw new Error("provider overloaded");
      },
    });
    assert.equal(calls, 2);
    assert.equal(result, "fallback:provider overloaded");
  });

  it("does not retry budget failures and throws when onExhausted is throw", async () => {
    let calls = 0;
    await assert.rejects(
      runNodeAttempt({
        maxAttempts: 3,
        nodeKey: "domain-c",
        attemptId: (i) => `domain-c@${i}`,
        onExhausted: "throw",
        run: async () => {
          calls += 1;
          throw new Error("token budget exhausted");
        },
      }),
      /budget/,
    );
    assert.equal(calls, 1);
  });

  it("does not retry budget failures and returns onExhausted fallback", async () => {
    let calls = 0;
    const result = await runNodeAttempt({
      maxAttempts: 3,
      nodeKey: "review",
      attemptId: (i) => `review@${i}`,
      onExhausted: (_err, { message }) => `closed:${message}`,
      run: async () => {
        calls += 1;
        throw new Error("token budget exhausted");
      },
    });
    assert.equal(calls, 1);
    assert.match(result, /^closed:token budget/);
  });

  it("rethrows AbortError immediately without retry", async () => {
    let calls = 0;
    await assert.rejects(
      runNodeAttempt({
        maxAttempts: 3,
        nodeKey: "domain-d",
        attemptId: (i) => `domain-d@${i}`,
        onExhausted: "throw",
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
