import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyChildSessionEvent,
  childSpanItemsSnapshot,
  createChildSpanProjectorState,
  MAX_ITEMS,
  MAX_TEXT_CHUNK,
  pushChildItem,
} from "./child-span-projector.js";

test("text_delta accumulates streamedText and coalesces text items", () => {
  let state = createChildSpanProjectorState();
  state = applyChildSessionEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hello " },
  });
  state = applyChildSessionEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "world" },
  });
  assert.equal(state.streamedText, "Hello world");
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0]!.type, "text");
  if (state.items[0]!.type === "text") {
    assert.equal(state.items[0]!.text, "Hello world");
  }
});

test("message_end assistant increments turns and records usage", () => {
  let state = createChildSpanProjectorState();
  state = applyChildSessionEvent(state, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { totalTokens: 1234 },
    },
  });
  assert.equal(state.turns, 1);
  assert.equal(state.contextTokens, 1234);
});

test("tool_execution_start/end correlates by toolCallId", () => {
  let state = createChildSpanProjectorState();
  state = applyChildSessionEvent(state, {
    type: "tool_execution_start",
    toolCallId: "call-a",
    toolName: "read",
    args: { path: "a.md" },
  });
  state = applyChildSessionEvent(state, {
    type: "tool_execution_start",
    toolCallId: "call-b",
    toolName: "grep",
    args: { pattern: "x" },
  });
  // End second first — must not flip first tool by name alone.
  state = applyChildSessionEvent(state, {
    type: "tool_execution_end",
    toolCallId: "call-b",
    toolName: "grep",
    result: { matches: [] },
    isError: false,
  });
  assert.equal(state.items[0]!.type, "toolCall");
  assert.equal(state.items[1]!.type, "toolCall");
  if (state.items[0]!.type === "toolCall") {
    assert.equal(state.items[0]!.name, "read");
    assert.equal(state.items[0]!.status, "running");
  }
  if (state.items[1]!.type === "toolCall") {
    assert.equal(state.items[1]!.name, "grep");
    assert.equal(state.items[1]!.status, "done");
  }
  state = applyChildSessionEvent(state, {
    type: "tool_execution_end",
    toolCallId: "call-a",
    toolName: "read",
    result: { content: "…" },
    isError: true,
  });
  if (state.items[0]!.type === "toolCall") {
    assert.equal(state.items[0]!.status, "error");
  }
});

test("tool_execution_end falls back to name when toolCallId missing", () => {
  let state = createChildSpanProjectorState();
  state = applyChildSessionEvent(state, {
    type: "tool_execution_start",
    toolName: "ls",
    args: { path: "." },
  });
  state = applyChildSessionEvent(state, {
    type: "tool_execution_end",
    toolName: "ls",
    result: {},
    isError: false,
  });
  assert.equal(state.items.length, 1);
  if (state.items[0]!.type === "toolCall") {
    assert.equal(state.items[0]!.status, "done");
  }
});

test("ignores unknown event types", () => {
  const state = createChildSpanProjectorState();
  applyChildSessionEvent(state, { type: "agent_start" });
  applyChildSessionEvent(state, null);
  applyChildSessionEvent(state, "nope");
  assert.equal(state.items.length, 0);
  assert.equal(state.turns, 0);
});

test("MAX_ITEMS cap drops oldest and reindexes toolCallId map", () => {
  const state = createChildSpanProjectorState();
  for (let i = 0; i < MAX_ITEMS + 3; i++) {
    applyChildSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: `c${i}`,
      toolName: `tool-${i}`,
      args: {},
    });
  }
  assert.equal(state.items.length, MAX_ITEMS);
  // Oldest three call ids should be gone from the map after shifts.
  assert.equal(state.toolIndexByCallId.has("c0"), false);
  assert.equal(state.toolIndexByCallId.has("c1"), false);
  assert.equal(state.toolIndexByCallId.has("c2"), false);
  assert.ok(state.toolIndexByCallId.has(`c${MAX_ITEMS + 2}`));
});

test("text chunks are truncated per delta", () => {
  const state = createChildSpanProjectorState();
  const huge = "x".repeat(MAX_TEXT_CHUNK + 50);
  applyChildSessionEvent(state, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: huge },
  });
  assert.equal(state.items[0]!.type, "text");
  if (state.items[0]!.type === "text") {
    assert.ok(state.items[0]!.text.length <= MAX_TEXT_CHUNK);
  }
  // Full stream still retained for summary resolution.
  assert.equal(state.streamedText.length, huge.length);
});

test("pushChildItem and snapshot helpers", () => {
  const state = createChildSpanProjectorState();
  pushChildItem(state, { type: "text", text: "a" });
  assert.deepEqual(childSpanItemsSnapshot(state), [{ type: "text", text: "a" }]);
  assert.equal(childSpanItemsSnapshot(createChildSpanProjectorState()), undefined);
});
