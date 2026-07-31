import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAttemptTranscriptLive,
  parseAttemptTranscriptErrorFrame,
  parseAttemptTranscriptTraceFrame,
  projectAttemptTranscriptMessages,
} from "./attempt-transcript.ts";

describe("projectAttemptTranscriptMessages", () => {
  it("projects canonical text and correlates tool result to its call", () => {
    const messages = projectAttemptTranscriptMessages([
      {
        trace: 1,
        ordinal: 1,
        at: "2026-07-31T00:00:00.000Z",
        kind: "input",
        content: "Investigate the cache.",
      },
      {
        trace: 1,
        ordinal: 2,
        at: "2026-07-31T00:00:01.000Z",
        kind: "tool_call",
        toolCallId: "read-1",
        name: "read",
        args: '{"path":"cache.ts"}',
      },
      {
        trace: 1,
        ordinal: 3,
        at: "2026-07-31T00:00:02.000Z",
        kind: "tool_result",
        toolCallId: "read-1",
        name: "read",
        output: "cache source",
        status: "done",
      },
    ]);

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[1]?.tools?.[0]?.name, "read");
    assert.deepEqual(messages[1]?.tools?.[0]?.args, { path: "cache.ts" });
    assert.equal(messages[1]?.tools?.[0]?.output, "cache source");
    assert.equal(messages[1]?.tools?.[0]?.status, "done");
  });

  it("does not reinterpret retired transcript rows", () => {
    assert.deepEqual(projectAttemptTranscriptMessages([{ role: "assistant", content: "old" }]), []);
  });
});

describe("isAttemptTranscriptLive", () => {
  it("opens SSE only for active attempt states", () => {
    assert.equal(isAttemptTranscriptLive("running"), true);
    assert.equal(isAttemptTranscriptLive("suspended"), true);
    assert.equal(isAttemptTranscriptLive("succeeded"), false);
  });
});

describe("Attempt transcript SSE frames", () => {
  it("accepts a canonical trace frame and rejects malformed frames", () => {
    const valid = JSON.stringify({
      attemptId: "attempt-1",
      nodeKey: "plan",
      state: "running",
      events: [
        {
          trace: 1,
          ordinal: 1,
          at: "2026-07-31T00:00:00.000Z",
          kind: "assistant",
          content: "Working",
        },
      ],
      cursor: 1,
      live: true,
    });
    assert.equal(parseAttemptTranscriptTraceFrame(valid)?.events.length, 1);
    assert.equal(
      parseAttemptTranscriptTraceFrame(
        JSON.stringify({
          ...JSON.parse(valid),
          events: [{ role: "assistant", content: "legacy" }],
        }),
      ),
      undefined,
    );
    assert.equal(
      parseAttemptTranscriptErrorFrame('{"message":"trace failed"}')?.message,
      "trace failed",
    );
    assert.equal(parseAttemptTranscriptErrorFrame('{"message":"","extra":true}'), undefined);
  });
});
