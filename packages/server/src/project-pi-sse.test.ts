import assert from "node:assert/strict";
import test from "node:test";
import { activeToolUpdate, projectPiEventForSse } from "./project-pi-sse.ts";

test("projectPiEventForSse redacts secrets in payload", () => {
  const event = {
    type: "agent_end",
    errorMessage: "auth failed sk-proj-ABCDEFGHIJKLMNOP",
  };
  const frame = projectPiEventForSse("ws", "sess", event, "2026-01-01T00:00:00.000Z");
  assert.equal(frame.source, "pi");
  assert.equal(frame.kind, "agent_end");
  assert.equal(frame.sessionId, "sess");
  const payload = frame.payload as { errorMessage?: string };
  assert.ok(payload.errorMessage?.includes("[redacted-key]"));
  assert.ok(!payload.errorMessage?.includes("ABCDEFGHIJKLMNOP"));
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
