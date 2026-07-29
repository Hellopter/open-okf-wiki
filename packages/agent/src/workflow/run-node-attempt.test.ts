/**
 * Classifier + decideNodeRetry + runNodeAttempt tests (pure; no Pi, no FS).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBestEffortChild } from "./best-effort-child.js";
import { classifyAgentFailure, classifyError, decideNodeRetry } from "./retry-policy.js";
import { runNodeAttempt } from "./run-node-attempt.js";

describe("classifyAgentFailure", () => {
  it("recognizes transient transport failures", () => {
    assert.equal(classifyAgentFailure("429 Too Many Requests"), "transient");
    assert.equal(classifyAgentFailure("upstream rate limit exceeded"), "transient");
    assert.equal(classifyAgentFailure("connect ECONNRESET"), "transient");
    assert.equal(classifyAgentFailure("fetch failed"), "transient");
    assert.equal(classifyAgentFailure("503 Service Unavailable"), "transient");
    assert.equal(classifyAgentFailure("provider overloaded"), "transient");
    assert.equal(classifyAgentFailure("request timeout"), "transient");
  });

  it("recognizes budget exhaustion and wall-clock timeout", () => {
    assert.equal(classifyAgentFailure("run token budget exhausted"), "budget");
    assert.equal(classifyAgentFailure("token budget exceeded"), "budget");
    assert.equal(classifyAgentFailure("request timed out after 120s"), "budget");
    assert.equal(classifyAgentFailure("timed out after 30"), "budget");
  });

  it("recognizes capacity / context overflow", () => {
    assert.equal(classifyAgentFailure("context overflow in session"), "capacity");
    assert.equal(classifyAgentFailure("compact-and-retry required"), "capacity");
    assert.equal(classifyAgentFailure("context length exceeded"), "capacity");
    assert.equal(classifyAgentFailure("maximum context size reached"), "capacity");
  });

  it("recognizes policy / billing / quota failures", () => {
    assert.equal(classifyAgentFailure("insufficient_quota for model"), "policy");
    assert.equal(classifyAgentFailure("out of budget for org"), "policy");
    assert.equal(classifyAgentFailure("quota exceeded"), "policy");
    assert.equal(classifyAgentFailure("billing hard limit reached"), "policy");
  });

  it("leaves unknown failures unclassified", () => {
    assert.equal(classifyAgentFailure("boom domain"), undefined);
    assert.equal(classifyAgentFailure(""), undefined);
    assert.equal(classifyAgentFailure(undefined), undefined);
  });
});

describe("classifyError", () => {
  it("maps named error types before message patterns", () => {
    const capacity = new Error("something else");
    capacity.name = "CapacityError";
    assert.equal(classifyError(capacity), "capacity");

    const budget = new Error("something else");
    budget.name = "BudgetError";
    assert.equal(classifyError(budget), "budget");

    const infra = new Error("disk full");
    infra.name = "InfrastructureError";
    assert.equal(classifyError(infra), "infrastructure");
  });

  it("falls back to message classification", () => {
    assert.equal(classifyError(new Error("429 rate limit")), "transient");
    assert.equal(classifyError(new Error("boom")), undefined);
  });
});

describe("decideNodeRetry", () => {
  it("fails immediately on transient (L0 already retried)", () => {
    const d = decideNodeRetry({ errorClass: "transient", attemptIndex: 0, maxAttempts: 2 });
    assert.equal(d.action, "fail");
  });

  it("fails immediately on unknown / undefined class", () => {
    const d = decideNodeRetry({ errorClass: undefined, attemptIndex: 0, maxAttempts: 2 });
    assert.equal(d.action, "fail");
  });

  it("fails immediately on policy, budget, capacity, infrastructure", () => {
    for (const errorClass of ["policy", "budget", "capacity", "infrastructure"] as const) {
      const d = decideNodeRetry({ errorClass, attemptIndex: 0, maxAttempts: 3 });
      assert.equal(d.action, "fail", errorClass);
    }
  });

  it("retries schema/quality once then fails", () => {
    const first = decideNodeRetry({ errorClass: "schema", attemptIndex: 0, maxAttempts: 2 });
    assert.equal(first.action, "retry");
    const second = decideNodeRetry({ errorClass: "schema", attemptIndex: 1, maxAttempts: 2 });
    assert.equal(second.action, "fail");

    const q = decideNodeRetry({ errorClass: "quality", attemptIndex: 0, maxAttempts: 2 });
    assert.equal(q.action, "retry");
  });

  it("returns needs_input for needs_input class", () => {
    const d = decideNodeRetry({ errorClass: "needs_input", attemptIndex: 0, maxAttempts: 2 });
    assert.equal(d.action, "needs_input");
  });
});

describe("runNodeAttempt", () => {
  it("does not retry transient failures (L0 already retried) — one call then throw", async () => {
    let calls = 0;
    const retries: number[] = [];
    await assert.rejects(
      runNodeAttempt({
        maxAttempts: 2,
        nodeKey: "domain-a",
        attemptId: (i) => (i === 0 ? "domain-a" : `domain-a@retry${i}`),
        onExhausted: "throw",
        onRetry: ({ attemptIndex }) => retries.push(attemptIndex),
        run: async () => {
          calls += 1;
          throw new Error("429 rate limit");
        },
      }),
      /429 rate limit/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(retries, []);
  });

  it("throws the last error on unknown class without retry (onExhausted: throw)", async () => {
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
    // Unknown class fails immediately — no L2 default retry.
    assert.equal(calls, 1);
  });

  it("returns onExhausted fallback for transient without retry", async () => {
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
    assert.equal(calls, 1);
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

  it("does not retry capacity failures", async () => {
    let calls = 0;
    await assert.rejects(
      runNodeAttempt({
        maxAttempts: 3,
        nodeKey: "domain-cap",
        attemptId: (i) => `domain-cap@${i}`,
        onExhausted: "throw",
        run: async () => {
          calls += 1;
          throw new Error("context overflow in domain reduce");
        },
      }),
      /context overflow/,
    );
    assert.equal(calls, 1);
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

describe("runBestEffortChild", () => {
  it("returns ok value on success", async () => {
    const result = await runBestEffortChild({ run: async () => 42 });
    assert.deepEqual(result, { ok: true, value: 42 });
  });

  it("returns classified failure without throwing", async () => {
    const result = await runBestEffortChild({
      run: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errorClass, "transient");
      assert.match(result.message, /429/);
    }
  });

  it("rethrows AbortError", async () => {
    await assert.rejects(
      runBestEffortChild({
        run: async () => {
          const err = new Error("cancelled");
          err.name = "AbortError";
          throw err;
        },
      }),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
  });
});
