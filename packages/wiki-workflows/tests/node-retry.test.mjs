import assert from "node:assert/strict";
import test from "node:test";
import {
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
} from "../dist/agent-errors.js";
import { WikiBudgetExhaustedError } from "../dist/failures.js";
import { classifyNodeFailure } from "../dist/node-retry.js";

test("context_budget with attempt < max is queued and retryable", () => {
  const error = new WikiAgentContextBudgetError("partial", [], "context overflow recovery failed");
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
  assert.equal(result.terminalRun, undefined);
  assert.equal(result.error.code, "context_budget_exceeded");
  assert.equal(result.error.retryable, true);
  assert.match(result.error.message, /context overflow recovery failed/);
});

test("context_budget with attempt >= max is blocked and terminalRun blocked", () => {
  const error = new WikiAgentContextBudgetError("partial", [], "context window exhausted");
  const result = classifyNodeFailure(error, { attempt: 3, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "blocked");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, "blocked");
  assert.equal(result.error.code, "context_budget_exceeded");
  assert.equal(result.error.retryable, false);
});

test("context_budget receives only one fresh-session retry", () => {
  const error = Object.assign(new Error("provider overflow"), { code: "context_budget_exceeded" });
  const result = classifyNodeFailure(error, { attempt: 2, maxAttempts: 4, aborted: false });
  assert.equal(result.status, "blocked");
  assert.equal(result.retryable, false);
  assert.equal(result.error.code, "context_budget_exceeded");
});

test("transient provider exhaustion receives one fresh-session retry", () => {
  const first = classifyNodeFailure(new Error("429 Too Many Requests"), {
    attempt: 1,
    maxAttempts: 3,
    aborted: false,
  });
  assert.equal(first.status, "queued");
  assert.equal(first.retryable, true);
  assert.equal(first.error.code, "execution_failed");

  const second = classifyNodeFailure(new Error("503 Service Unavailable"), {
    attempt: 2,
    maxAttempts: 3,
    aborted: false,
  });
  assert.equal(second.status, "failed");
  assert.equal(second.retryable, false);
  assert.equal(second.terminalRun, "failed");
});

test("executor deadline errors are transient for one fresh-session retry", () => {
  const result = classifyNodeFailure(new Error("Wiki agent session timed out after 1000ms"), {
    attempt: 1,
    maxAttempts: 3,
    aborted: false,
  });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
});

test("maxTransientSessionAttempts=1 disables the fresh-session retry", () => {
  const result = classifyNodeFailure(new Error("503 Service Unavailable"), {
    attempt: 1,
    maxAttempts: 3,
    maxTransientSessionAttempts: 1,
    aborted: false,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
});

test("permanent provider failures are not retried", () => {
  for (const message of ["401 Unauthorized", "insufficient_quota", "invalid request: bad schema"]) {
    const result = classifyNodeFailure(new Error(message), {
      attempt: 1,
      maxAttempts: 3,
      aborted: false,
    });
    assert.equal(result.status, "failed", message);
    assert.equal(result.retryable, false, message);
  }
});

test("validator_infrastructure requeues while attempts remain", () => {
  const error = new WikiAgentProtocolError(["wiki_submit_page"], "", [], {
    code: "validator_infrastructure",
    message: "validator unavailable",
  });
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
  assert.equal(result.terminalRun, undefined);
  assert.equal(result.error.code, "validator_infrastructure");
  assert.deepEqual(result.error.requiredSubmissionTools, ["wiki_submit_page"]);
  assert.equal(result.error.retryable, true);
});

test("validator_infrastructure fails after max attempts", () => {
  const error = new WikiAgentProtocolError(["wiki_submit_page"], "", [], {
    code: "validator_infrastructure",
    message: "validator unavailable",
  });
  const result = classifyNodeFailure(error, { attempt: 3, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, "failed");
  assert.equal(result.error.code, "validator_infrastructure");
});

test("loop budget error is blocked with terminalRun blocked", () => {
  // Production message style from engine.ensureResearchRoundAvailable — classify by code, not text.
  const error = new WikiBudgetExhaustedError(
    "Research reached the 6-round limit before coverage saturated",
    "research_rounds_exhausted",
  );
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "blocked");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, "blocked");
  assert.equal(result.error.code, "research_rounds_exhausted");
});

test("duck-typed research_rounds_exhausted code is blocked", () => {
  const error = Object.assign(new Error("Research reached the 6-round limit before coverage saturated"), {
    code: "research_rounds_exhausted",
  });
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "blocked");
  assert.equal(result.terminalRun, "blocked");
  assert.equal(result.error.code, "research_rounds_exhausted");
});

test("aborted execution is cancelled regardless of error type", () => {
  const error = new WikiAgentContextBudgetError("partial", [], "context overflow");
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: true });
  assert.equal(result.status, "cancelled");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, undefined);
  assert.equal(result.error.code, "cancelled");
});

test("generic error fails the node and the run", () => {
  const result = classifyNodeFailure(new Error("disk full"), {
    attempt: 1,
    maxAttempts: 3,
    aborted: false,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, "failed");
  assert.equal(result.error.code, "execution_failed");
  assert.equal(result.error.message, "disk full");
});

test("missing submission receives one fresh-session retry", () => {
  const error = new WikiAgentProtocolError(["wiki_submit_research"], "no call", []);
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
  assert.equal(result.terminalRun, undefined);
  assert.equal(result.error.code, "missing_submission");
  assert.deepEqual(result.error.requiredSubmissionTools, ["wiki_submit_research"]);
});

test("missing-submission recovery is independent of transient provider session policy", () => {
  const error = new WikiAgentProtocolError(["wiki_submit_review"], "no call", []);
  const result = classifyNodeFailure(error, {
    attempt: 1,
    maxAttempts: 3,
    maxTransientSessionAttempts: 1,
    aborted: false,
  });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
});

test("missing submission fails after the fresh-session retry", () => {
  const error = new WikiAgentProtocolError(["wiki_submit_research"], "no call", []);
  const result = classifyNodeFailure(error, {
    attempt: 2,
    maxAttempts: 3,
    missingSubmissionRetryUsed: true,
    aborted: false,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, "failed");
});

test("an earlier transient attempt does not consume missing-submission recovery", () => {
  const error = new WikiAgentProtocolError(["wiki_submit_synthesis_finalize"], "no call", []);
  const result = classifyNodeFailure(error, {
    attempt: 2,
    maxAttempts: 3,
    missingSubmissionRetryUsed: false,
    aborted: false,
  });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
});
