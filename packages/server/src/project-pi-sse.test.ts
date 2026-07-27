import assert from "node:assert/strict";
import test from "node:test";
import {
  activeToolUpdate,
  initialLiveStreamState,
  projectLiveStreamEvent,
  projectPiEventForSse,
} from "./project-pi-sse.ts";

test("projectLiveStreamEvent redacts secrets in stream error text", () => {
  const event = {
    type: "error",
    message: "auth failed sk-proj-ABCDEFGHIJKLMNOP",
  };
  const { frame, state } = projectLiveStreamEvent(
    "sess",
    initialLiveStreamState(),
    event,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(frame.source, "server");
  assert.equal(frame.kind, "stream");
  assert.equal(frame.sessionId, "sess");
  assert.equal(state.agentStatus, "error");
  assert.ok(frame.payload.errorText?.includes("[redacted-key]"));
  assert.ok(!frame.payload.errorText?.includes("ABCDEFGHIJKLMNOP"));
  assert.ok(frame.payload.appended.some((m) => m.role === "system"));
});

test("projectLiveStreamEvent projects assistant streaming text", () => {
  let state = initialLiveStreamState();
  const start = projectLiveStreamEvent("sess", state, {
    type: "agent_start",
  });
  state = start.state;
  assert.equal(state.turnActive, true);
  assert.equal(state.agentStatus, "streaming");

  const mid = projectLiveStreamEvent("sess", state, {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    },
  });
  assert.equal(mid.state.streamingMessage?.content, "Hello");
  assert.equal(mid.frame.payload.streamingMessage?.content, "Hello");
  assert.equal(mid.frame.payload.appended.length, 0);

  const end = projectLiveStreamEvent("sess", mid.state, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
      stopReason: "stop",
    },
  });
  assert.equal(end.state.streamingMessage, null);
  assert.equal(end.frame.payload.appended.length, 1);
  assert.equal(end.frame.payload.appended[0]?.content, "Hello world");
  assert.equal(end.frame.payload.appended[0]?.status, "done");
});

test("projectPiEventForSse remains a thin wrapper over empty state", () => {
  const frame = projectPiEventForSse(
    "ws",
    "sess",
    { type: "agent_start" },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(frame.source, "server");
  assert.equal(frame.kind, "stream");
  assert.equal(frame.payload.turnActive, true);
});

test("activeToolUpdate clears on tool_execution_end", () => {
  assert.equal(activeToolUpdate({ type: "tool_execution_end" }), null);
});

test("activeToolUpdate extracts wiki_produce details from tool_execution_update", () => {
  const tool = activeToolUpdate({
    type: "tool_execution_update",
    toolCallId: "tc1",
    toolName: "wiki_produce",
    partialResult: {
      details: {
        status: "awaiting_plan",
        runId: "run-1",
        summary: "waiting",
      },
    },
  });
  assert.ok(tool);
  assert.equal(tool.toolCallId, "tc1");
  assert.equal(tool.toolName, "wiki_produce");
  assert.equal(tool.details.status, "awaiting_plan");
});

test("activeToolUpdate ignores non-wiki partial updates", () => {
  assert.equal(
    activeToolUpdate({
      type: "tool_execution_update",
      toolCallId: "x",
      toolName: "read",
      partialResult: { details: { not: "wiki" } },
    }),
    undefined,
  );
});
