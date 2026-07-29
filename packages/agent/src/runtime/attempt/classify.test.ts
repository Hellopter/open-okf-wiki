/**
 * Unit tests for the sole attempt-edge failure classifier.
 *
 * Covers: abort, capacity, timeout/budget, policy→budget, transport, provider,
 * unknown fail-closed — and that classifyError (structured/named) wins first.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetError, CapacityError, InfrastructureError } from "../run-scoped-agent.js";
import { classifyPiFailureClass, failure } from "./classify.js";

function openSignal(): AbortSignal {
  return new AbortController().signal;
}

function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

describe("classifyPiFailureClass", () => {
  it("maps abort signal and AbortError to cancelled", () => {
    assert.equal(classifyPiFailureClass(new Error("boom"), abortedSignal()), "cancelled");
    const abort = new Error("Wiki Run cancelled");
    abort.name = "AbortError";
    assert.equal(classifyPiFailureClass(abort, openSignal()), "cancelled");
  });

  it("maps capacity via named CapacityError and message patterns (classifyError first)", () => {
    assert.equal(
      classifyPiFailureClass(new CapacityError("context overflow / compact exhausted"), openSignal()),
      "capacity",
    );
    // Named type wins even when message looks like transport.
    const named = new Error("429 rate limit");
    named.name = "CapacityError";
    assert.equal(classifyPiFailureClass(named, openSignal()), "capacity");
    assert.equal(
      classifyPiFailureClass(new Error("prompt is too long for model"), openSignal()),
      "capacity",
    );
    assert.equal(
      classifyPiFailureClass(new Error("context_length exceeded"), openSignal()),
      "capacity",
    );
    assert.equal(
      classifyPiFailureClass(new Error("task exceeds capacity gate"), openSignal()),
      "capacity",
    );
  });

  it("maps wall-clock timeout and token budget to budget", () => {
    assert.equal(
      classifyPiFailureClass(
        new BudgetError("Scoped agent timed out after 120000 ms (workspace request timeout)"),
        openSignal(),
      ),
      "budget",
    );
    assert.equal(
      classifyPiFailureClass(new Error("run token budget exhausted"), openSignal()),
      "budget",
    );
    assert.equal(
      classifyPiFailureClass(new Error("request timed out after 30s"), openSignal()),
      "budget",
    );
  });

  it("folds policy / quota / billing (ErrorClass policy) into budget", () => {
    assert.equal(
      classifyPiFailureClass(new Error("insufficient_quota for model"), openSignal()),
      "budget",
    );
    assert.equal(
      classifyPiFailureClass(new Error("billing hard limit reached"), openSignal()),
      "budget",
    );
    assert.equal(
      classifyPiFailureClass(new Error("out of credits on account"), openSignal()),
      "budget",
    );
    // Structured errorClass policy → budget via classifyError map.
    assert.equal(
      classifyPiFailureClass(Object.assign(new Error("x"), { errorClass: "policy" }), openSignal()),
      "budget",
    );
  });

  it("maps transport / overload to infrastructure (not capacity)", () => {
    assert.equal(
      classifyPiFailureClass(new Error("429 Too Many Requests"), openSignal()),
      "infrastructure",
    );
    assert.equal(
      classifyPiFailureClass(new Error("provider overloaded"), openSignal()),
      "infrastructure",
    );
    assert.equal(
      classifyPiFailureClass(new Error("connect ECONNRESET"), openSignal()),
      "infrastructure",
    );
    assert.equal(
      classifyPiFailureClass(new Error("503 Service Unavailable"), openSignal()),
      "infrastructure",
    );
    // ErrorClass transient → infrastructure.
    assert.equal(
      classifyPiFailureClass(
        Object.assign(new Error("flake"), { errorClass: "transient" }),
        openSignal(),
      ),
      "infrastructure",
    );
  });

  it("maps InfrastructureError and structured infrastructure via classifyError first", () => {
    assert.equal(
      classifyPiFailureClass(new InfrastructureError("disk full"), openSignal()),
      "infrastructure",
    );
    assert.equal(
      classifyPiFailureClass(
        Object.assign(new Error("host boom"), { errorClass: "infrastructure" }),
        openSignal(),
      ),
      "infrastructure",
    );
  });

  it("maps stable provider / auth message patterns to provider", () => {
    assert.equal(
      classifyPiFailureClass(new Error("invalid API key"), openSignal()),
      "provider",
    );
    assert.equal(
      classifyPiFailureClass(new Error("authentication failed"), openSignal()),
      "provider",
    );
    assert.equal(
      classifyPiFailureClass(new Error("model not found: xyz"), openSignal()),
      "provider",
    );
  });

  it("fail-closes unknown messages as infrastructure", () => {
    assert.equal(classifyPiFailureClass(new Error("boom domain"), openSignal()), "infrastructure");
    assert.equal(classifyPiFailureClass("weird", openSignal()), "infrastructure");
    assert.equal(classifyPiFailureClass(undefined, openSignal()), "infrastructure");
  });

  it("prefers structured errorClass over contradictory message text", () => {
    // classifyError reads errorClass first — capacity must win over "429" text.
    assert.equal(
      classifyPiFailureClass(
        Object.assign(new Error("429 rate limit"), { errorClass: "capacity" }),
        openSignal(),
      ),
      "capacity",
    );
    assert.equal(
      classifyPiFailureClass(
        Object.assign(new Error("context overflow"), { errorClass: "budget" }),
        openSignal(),
      ),
      "budget",
    );
  });

  it("maps schema/quality/needs_input ErrorClass to infrastructure at Pi edge", () => {
    assert.equal(
      classifyPiFailureClass(
        Object.assign(new Error("bad schema"), { errorClass: "schema" }),
        openSignal(),
      ),
      "infrastructure",
    );
    assert.equal(
      classifyPiFailureClass(
        Object.assign(new Error("quality"), { errorClass: "quality" }),
        openSignal(),
      ),
      "infrastructure",
    );
  });
});

describe("failure", () => {
  it("builds a typed failed PiAttemptOutcome", () => {
    const out = failure(new CapacityError("context overflow"), openSignal());
    assert.equal(out.type, "failed");
    if (out.type === "failed") {
      assert.equal(out.failureClass, "capacity");
      assert.match(out.error, /context overflow/);
    }
  });

  it("records cancelled with abort signal", () => {
    const out = failure(new Error("ignored"), abortedSignal());
    assert.equal(out.type, "failed");
    if (out.type === "failed") {
      assert.equal(out.failureClass, "cancelled");
    }
  });
});
