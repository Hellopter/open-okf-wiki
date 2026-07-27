/**
 * W4 pi-message coverage: parsers live in contract; re-import so web package
 * still runs the suite (and catches export/resolution regressions).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentContentPart, AgentToolCall } from "@okf-wiki/contract";
import {
  assistantFromSnapshot,
  extractPartsFromMessage,
  extractToolCallsFromMessage,
} from "./pi-message.ts";

const tool = (id: string, name = "read"): AgentToolCall => ({
  id,
  name,
  status: "pending",
});

describe("extractPartsFromMessage (via contract re-export)", () => {
  it("preserves interleaved text + thinking + toolCall order", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Before " },
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "mid " },
        {
          type: "toolCall",
          id: "t1",
          name: "read",
          arguments: { path: "a.ts" },
        },
        { type: "text", text: "after" },
      ],
    };
    const tools = extractToolCallsFromMessage(message);
    const parts = extractPartsFromMessage(message, tools);
    assert.deepEqual(parts, [
      { type: "text", text: "Before " },
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "mid " },
      { type: "tool", toolId: "t1" },
      { type: "text", text: "after" },
    ]);
  });

  it("merges prevParts when content is empty but tools arrive", () => {
    const prevParts: AgentContentPart[] = [
      { type: "text", text: "earlier" },
      { type: "tool", toolId: "t-old" },
    ];
    const parts = extractPartsFromMessage(
      { role: "assistant" },
      [tool("t-old"), tool("t-new")],
      prevParts,
    );
    assert.deepEqual(parts, [
      { type: "text", text: "earlier" },
      { type: "tool", toolId: "t-old" },
      { type: "tool", toolId: "t-new" },
    ]);
  });

  it("does not drop prev text when only tools are known", () => {
    const prevParts: AgentContentPart[] = [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "streamed so far" },
    ];
    const parts = extractPartsFromMessage(
      { role: "assistant", content: [] },
      [tool("only-from-execution", "bash")],
      prevParts,
    );
    assert.deepEqual(parts, [
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "streamed so far" },
      { type: "tool", toolId: "only-from-execution" },
    ]);
  });
});

describe("assistantFromSnapshot (via contract re-export)", () => {
  it("attaches parts from content interleaving", () => {
    const msg = assistantFromSnapshot(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "f.ts" } },
        ],
      },
      { id: "asst-1", status: "done", ts: "2026-07-27T00:00:00.000Z" },
    );
    assert.equal(msg.content, "answer");
    assert.deepEqual(msg.parts, [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
      { type: "tool", toolId: "tool-1" },
    ]);
  });
});
