import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isAttemptTranscriptLive,
  projectAttemptTranscriptMessages,
} from "./attempt-transcript.ts";

describe("projectAttemptTranscriptMessages", () => {
  it("projects Pi-ish role + content rows", () => {
    const out = projectAttemptTranscriptMessages([
      { role: "user", content: "plan the wiki" },
      { role: "assistant", content: "drafting overview" },
    ]);
    assert.deepEqual(out, [
      { kind: "role", role: "user", text: "plan the wiki" },
      { kind: "role", role: "assistant", text: "drafting overview" },
    ]);
  });

  it("flattens content part arrays", () => {
    const out = projectAttemptTranscriptMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, "role");
    assert.equal(out[0]?.text, "hello\nworld");
  });

  it("projects tool-ish rows as compact tool lines", () => {
    const out = projectAttemptTranscriptMessages([
      { toolName: "read", status: "ok", arguments: { path: "a.ts" } },
      { type: "toolCall", name: "bash", args: { command: "ls" } },
      { name: "write", arguments: { path: "out.md" } },
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0]?.kind, "tool");
    assert.match(out[0]!.text, /read/);
    assert.match(out[0]!.text, /ok/);
    assert.equal(out[1]?.kind, "tool");
    assert.match(out[1]!.text, /bash|toolCall/);
    assert.equal(out[2]?.kind, "tool");
    assert.match(out[2]!.text, /write/);
  });

  it("falls back to truncated JSON for opaque rows", () => {
    const out = projectAttemptTranscriptMessages([{ schema: 1, node: "plan", noise: true }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, "raw");
    assert.ok(out[0]!.text.includes("schema"));
    assert.ok(out[0]!.text.includes("plan"));
  });

  it("stringifies non-object rows", () => {
    const out = projectAttemptTranscriptMessages(["hello", 42, null]);
    assert.equal(out.length, 3);
    assert.equal(out[0]?.kind, "raw");
    assert.equal(out[0]?.text, '"hello"');
    assert.equal(out[1]?.text, "42");
    assert.equal(out[2]?.text, "null");
  });

  it("returns empty list for empty input", () => {
    assert.deepEqual(projectAttemptTranscriptMessages([]), []);
  });
});

describe("isAttemptTranscriptLive", () => {
  it("is live only for running/suspended", () => {
    assert.equal(isAttemptTranscriptLive("running"), true);
    assert.equal(isAttemptTranscriptLive("suspended"), true);
    assert.equal(isAttemptTranscriptLive("succeeded"), false);
    assert.equal(isAttemptTranscriptLive("failed"), false);
    assert.equal(isAttemptTranscriptLive(undefined), false);
  });
});
