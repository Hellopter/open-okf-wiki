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

test("context_budget via duck-typed code also requeues", () => {
  const error = Object.assign(new Error("provider overflow"), { code: "context_budget_exceeded" });
  const result = classifyNodeFailure(error, { attempt: 2, maxAttempts: 4, aborted: false });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
  assert.equal(result.error.code, "context_budget_exceeded");
});

test("validator_infrastructure requeues while attempts remain", () => {
  const error = new WikiAgentProtocolError("wiki_submit_page", "", [], {
    code: "validator_infrastructure",
    message: "validator unavailable",
  });
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "queued");
  assert.equal(result.retryable, true);
  assert.equal(result.terminalRun, undefined);
  assert.equal(result.error.code, "validator_infrastructure");
  assert.equal(result.error.requiredSubmissionTool, "wiki_submit_page");
  assert.equal(result.error.retryable, true);
});

test("validator_infrastructure fails after max attempts", () => {
  const error = new WikiAgentProtocolError("wiki_submit_page", "", [], {
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

test("non-infrastructure protocol errors fail without retry", () => {
  const error = new WikiAgentProtocolError("wiki_submit_research", "no call", []);
  const result = classifyNodeFailure(error, { attempt: 1, maxAttempts: 3, aborted: false });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.terminalRun, "failed");
  assert.equal(result.error.code, "missing_submission");
  assert.equal(result.error.requiredSubmissionTool, "wiki_submit_research");
});
