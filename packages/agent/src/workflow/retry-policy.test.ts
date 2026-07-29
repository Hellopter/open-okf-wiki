/**
 * Classifier + best-effort child tests (pure; no Pi, no FS).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBestEffortChild } from "./best-effort-child.js";
import { classifyAgentFailure, classifyError } from "./retry-policy.js";

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
