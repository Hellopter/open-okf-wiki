import assert from "node:assert/strict";
import test from "node:test";
import { decideWikiAgentAttempt } from "../dist/agent-attempt-policy.js";
import { WikiTaskExecutionError } from "../dist/delegate-contracts.js";

test("AgentAttemptPolicy owns Retry-After, full jitter, pause and terminal decisions", () => {
  const decide = (input) => decideWikiAgentAttempt({ ...input, baseRetryDelayMs: 100, random: () => 0.5 });
  assert.deepEqual(decide({ error: Object.assign(new Error("limited"), { status: 429, retryAfterMs: 750 }), attempt: 1, maxAttempts: 3 }), {
    action: "retry", failure: { code: "rate_limit", message: "limited", retryable: true, retryAfterMs: 750 }, delayMs: 750,
  });
  assert.equal(decide({ error: Object.assign(new Error("bad gateway"), { status: 502 }), attempt: 2, maxAttempts: 3 }).delayMs, 100);
  assert.equal(decide({ error: new Error("quota exceeded"), attempt: 1, maxAttempts: 3 }).action, "pause");
  assert.equal(decide({ error: new WikiTaskExecutionError("schema", "schema"), attempt: 1, maxAttempts: 3 }).action, "fail");
  assert.equal(decide({ error: Object.assign(new Error("bad gateway"), { status: 502 }), attempt: 3, maxAttempts: 3 }).action, "fail");
});
