import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAttemptTranscriptLive, projectAttemptTranscriptMessages } from "./attempt-transcript.ts";

describe("projectAttemptTranscriptMessages", () => {
  it("projects Pi-ish role + content rows as AgentMessage[]", () => {
    const out = projectAttemptTranscriptMessages([
      { role: "user", content: "plan the wiki" },
      { role: "assistant", content: "drafting overview" },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.role, "user");
    assert.equal(out[0]?.content, "plan the wiki");
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[1]?.content, "drafting overview");
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
    assert.equal(out[0]?.role, "assistant");
    // Same join as contract projectAgentMessagesFromPiHistory / extractMessageText.
    assert.equal(out[0]?.content, "helloworld");
  });

  it("projects tool-ish rows as assistant tools for ToolExecutionCard", () => {
    const out = projectAttemptTranscriptMessages([
      { toolName: "read", status: "ok", arguments: { path: "a.ts" } },
      { type: "toolCall", name: "bash", args: { command: "ls" }, status: "done" },
      { name: "write", arguments: { path: "out.md" } },
    ]);
    assert.equal(out.length, 3);
    for (const msg of out) {
      assert.equal(msg.role, "assistant");
      assert.ok(msg.tools && msg.tools.length === 1);
    }
    assert.equal(out[0]?.tools?.[0]?.name, "read");
    assert.equal(out[0]?.tools?.[0]?.status, "done");
    assert.equal(out[1]?.tools?.[0]?.name, "bash");
    assert.equal(out[2]?.tools?.[0]?.name, "write");
  });

  it("projects AttemptItem text and toolCall rows", () => {
    const out = projectAttemptTranscriptMessages([
      { type: "text", text: "scouting sources" },
      { type: "toolCall", name: "read", status: "done", argsSummary: '{"path":"a.ts"}' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.role, "assistant");
    assert.equal(out[0]?.content, "scouting sources");
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[1]?.tools?.[0]?.name, "read");
    assert.deepEqual(out[1]?.tools?.[0]?.args, { path: "a.ts" });
  });

  it("projects legacy metadata stubs as assistant summary", () => {
    const out = projectAttemptTranscriptMessages([
      { schema: 1, node: "plan", mode: "fixture", summary: "Fixture default WikiRunSpec" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.role, "assistant");
    assert.match(out[0]!.content, /Fixture default/);
  });

  it("falls back to system row for opaque rows without summary", () => {
    const out = projectAttemptTranscriptMessages([{ schema: 1, node: "plan", noise: true }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.role, "system");
    assert.ok(out[0]!.content.includes("schema"));
    assert.ok(out[0]!.content.includes("plan"));
  });

  it("stringifies non-object rows as system", () => {
    const out = projectAttemptTranscriptMessages(["hello", 42, null]);
    assert.equal(out.length, 3);
    assert.equal(out[0]?.role, "system");
    assert.equal(out[0]?.content, '"hello"');
    assert.equal(out[1]?.content, "42");
    assert.equal(out[2]?.content, "null");
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
