import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AgentContentPart,
  AgentMessageSchema,
  type AgentToolCall,
  AgentToolCallSchema,
  assistantFromSnapshot,
  extractPartsFromMessage,
  extractToolCallsFromMessage,
  projectAgentMessagesFromPiHistory,
} from "./agent-message.js";

const tool = (id: string, name = "read"): AgentToolCall => ({
  id,
  name,
  status: "pending",
});

describe("AgentMessageSchema", () => {
  it("accepts stable wire shape and rejects optimistic-only fields", () => {
    const ok = AgentMessageSchema.parse({
      id: "m1",
      role: "assistant",
      content: "hi",
      createdAt: "2026-07-27T00:00:00.000Z",
      status: "done",
      parts: [
        { type: "text", text: "hi" },
        { type: "tool", toolId: "t1" },
      ],
      tools: [{ id: "t1", name: "read", status: "done" }],
    });
    assert.equal(ok.id, "m1");

    assert.equal(
      AgentMessageSchema.safeParse({
        id: "m1",
        role: "user",
        content: "x",
        createdAt: "2026-07-27T00:00:00.000Z",
        optimistic: true,
      }).success,
      false,
    );
  });

  it("validates tool call status enum", () => {
    assert.equal(
      AgentToolCallSchema.safeParse({ id: "t", name: "x", status: "running" }).success,
      true,
    );
    assert.equal(
      AgentToolCallSchema.safeParse({ id: "t", name: "x", status: "queued" }).success,
      false,
    );
  });
});

describe("extractPartsFromMessage", () => {
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

  it("flushes consecutive text buffers as one part; same for thinking", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hel" },
        { type: "text", text: "lo " },
        { type: "text", text: "world" },
        { type: "thinking", thinking: "step1" },
        { type: "thinking", thinking: "step2" },
        { type: "text", text: "!" },
      ],
    };
    const parts = extractPartsFromMessage(message, undefined);
    assert.deepEqual(parts, [
      { type: "text", text: "Hello world" },
      { type: "thinking", thinking: "step1step2" },
      { type: "text", text: "!" },
    ]);
  });

  it("appends tools that only exist in the tool list (not in content) at the end", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        {
          type: "toolCall",
          id: "in-content",
          name: "read",
          arguments: {},
        },
      ],
    };
    const tools: AgentToolCall[] = [tool("in-content"), tool("exec-only", "bash")];
    const parts = extractPartsFromMessage(message, tools);
    assert.deepEqual(parts, [
      { type: "text", text: "calling" },
      { type: "tool", toolId: "in-content" },
      { type: "tool", toolId: "exec-only" },
    ]);
  });

  it("merges prevParts when content is empty but tools arrive (tool_execution before toolCall)", () => {
    const prevParts: AgentContentPart[] = [
      { type: "text", text: "earlier" },
      { type: "tool", toolId: "t-old" },
    ];
    const message = { role: "assistant" };
    const tools = [tool("t-old"), tool("t-new")];
    const parts = extractPartsFromMessage(message, tools, prevParts);
    assert.deepEqual(parts, [
      { type: "text", text: "earlier" },
      { type: "tool", toolId: "t-old" },
      { type: "tool", toolId: "t-new" },
    ]);
  });

  it("does not drop prev text when only tools are known (empty content array)", () => {
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

  it("returns undefined for empty input", () => {
    assert.equal(extractPartsFromMessage(undefined, undefined), undefined);
    assert.equal(extractPartsFromMessage(null, undefined), undefined);
    assert.equal(extractPartsFromMessage({}, undefined), undefined);
    assert.equal(extractPartsFromMessage({ role: "assistant", content: [] }, undefined), undefined);
    assert.equal(extractPartsFromMessage({ content: [] }, [], undefined), undefined);
  });

  it("handles toolCall mid-stream and empty string blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "" },
        {
          type: "toolCall",
          id: "mid",
          name: "grep",
          arguments: { pattern: "x" },
        },
        { type: "text", text: "post-tool" },
        { type: "thinking", thinking: "reflect" },
        null,
        "noise",
        { type: "unknown", value: 1 },
      ],
    };
    const tools = extractToolCallsFromMessage(message);
    const parts = extractPartsFromMessage(message, tools);
    assert.deepEqual(parts, [
      { type: "tool", toolId: "mid" },
      { type: "text", text: "post-tool" },
      { type: "thinking", thinking: "reflect" },
    ]);
  });

  it("does not duplicate tool parts already present in content", () => {
    const message = {
      content: [{ type: "toolCall", id: "same", name: "read", arguments: {} }],
    };
    const parts = extractPartsFromMessage(message, [tool("same"), tool("same")]);
    assert.deepEqual(parts, [{ type: "tool", toolId: "same" }]);
  });

  it("prefers content-built parts over prevParts when content is non-empty", () => {
    const prevParts: AgentContentPart[] = [{ type: "text", text: "stale" }];
    const message = {
      content: [{ type: "text", text: "fresh" }],
    };
    const parts = extractPartsFromMessage(message, undefined, prevParts);
    assert.deepEqual(parts, [{ type: "text", text: "fresh" }]);
  });

  it("returns prevParts unchanged when content empty and no new tools", () => {
    const prevParts: AgentContentPart[] = [
      { type: "thinking", thinking: "keep" },
      { type: "tool", toolId: "t1" },
    ];
    const parts = extractPartsFromMessage({ content: [] }, [tool("t1")], prevParts);
    assert.deepEqual(parts, prevParts);
  });
});

describe("extractToolCallsFromMessage", () => {
  it("extracts toolCall blocks and keeps prev-only tools", () => {
    const message = {
      content: [
        { type: "text", text: "hi" },
        {
          type: "toolCall",
          id: "a",
          name: "read",
          arguments: { path: "x" },
        },
      ],
    };
    const prev: AgentToolCall[] = [
      { id: "a", name: "read", args: { path: "old" }, status: "running", output: "partial" },
      { id: "b", name: "bash", status: "running" },
    ];
    const tools = extractToolCallsFromMessage(message, prev);
    assert.deepEqual(tools, [
      {
        id: "a",
        name: "read",
        args: { path: "x" },
        output: "partial",
        status: "running",
      },
      { id: "b", name: "bash", status: "running" },
    ]);
  });
});

describe("assistantFromSnapshot", () => {
  it("attaches parts from content interleaving", () => {
    const message = {
      role: "assistant",
      id: "pi-1",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "answer" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "f.ts" },
        },
      ],
      stopReason: "stop",
    };
    const msg = assistantFromSnapshot(message, {
      id: "asst-1",
      status: "done",
      ts: "2026-07-27T00:00:00.000Z",
    });
    assert.equal(msg.content, "answer");
    assert.equal(msg.thinking, "hmm");
    assert.equal(msg.thinkingStatus, "done");
    assert.deepEqual(msg.parts, [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
      { type: "tool", toolId: "tool-1" },
    ]);
    assert.equal(msg.tools?.length, 1);
    assert.equal(msg.tools?.[0]?.id, "tool-1");
    assert.equal(msg.status, "done");
    assert.equal(AgentMessageSchema.safeParse(msg).success, true);
  });

  it("preserves prev parts merge when snapshot has no content yet", () => {
    const prev = assistantFromSnapshot(
      {
        role: "assistant",
        content: [{ type: "text", text: "streamed" }],
      },
      {
        id: "asst-2",
        status: "streaming",
        ts: "2026-07-27T00:00:00.000Z",
      },
    );
    const next = assistantFromSnapshot(
      { role: "assistant" },
      {
        id: "asst-2",
        prev: {
          ...prev,
          tools: [tool("late-tool", "bash")],
        },
        status: "streaming",
        ts: "2026-07-27T00:00:01.000Z",
      },
    );
    assert.equal(next.content, "streamed");
    assert.ok(next.parts?.some((p) => p.type === "text" && p.text === "streamed"));
    assert.ok(next.parts?.some((p) => p.type === "tool" && p.toolId === "late-tool"));
  });
});

describe("projectAgentMessagesFromPiHistory", () => {
  it("projects user + assistant + toolResult into AgentMessage[]", () => {
    const rows = [
      {
        role: "user",
        id: "u1",
        content: "hello",
        timestamp: Date.parse("2026-07-27T00:00:00.000Z"),
      },
      {
        role: "assistant",
        id: "a1",
        content: [
          { type: "text", text: "working" },
          { type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } },
        ],
        timestamp: Date.parse("2026-07-27T00:00:01.000Z"),
      },
      {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: Date.parse("2026-07-27T00:00:02.000Z"),
      },
    ];
    const messages = projectAgentMessagesFromPiHistory(rows);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.content, "hello");
    assert.equal(messages[1]?.role, "assistant");
    assert.equal(messages[1]?.tools?.[0]?.id, "tc1");
    assert.equal(messages[1]?.tools?.[0]?.status, "done");
    assert.equal(messages[1]?.tools?.[0]?.output, "file body");
    assert.equal(AgentMessageSchema.safeParse(messages[0]).success, true);
    assert.equal(AgentMessageSchema.safeParse(messages[1]).success, true);
  });

  it("finalizes toolCall without toolResult as error (not pending)", () => {
    const rows = [
      {
        role: "assistant",
        id: "a1",
        content: [
          { type: "text", text: "calling" },
          { type: "toolCall", id: "orphan-1", name: "bash", arguments: { cmd: "ls" } },
        ],
        timestamp: Date.parse("2026-07-27T00:00:01.000Z"),
      },
    ];
    const messages = projectAgentMessagesFromPiHistory(rows);
    assert.equal(messages.length, 1);
    const tool = messages[0]?.tools?.[0];
    assert.equal(tool?.id, "orphan-1");
    assert.equal(tool?.status, "error");
    assert.equal(tool?.output, "Interrupted");
  });

  it("keeps completed tools done while finalizing siblings without toolResult", () => {
    const rows = [
      {
        role: "assistant",
        id: "a1",
        content: [
          { type: "toolCall", id: "ok", name: "read", arguments: {} },
          { type: "toolCall", id: "missing", name: "bash", arguments: {} },
        ],
        timestamp: Date.parse("2026-07-27T00:00:01.000Z"),
      },
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "read",
        content: [{ type: "text", text: "ok body" }],
        isError: false,
        timestamp: Date.parse("2026-07-27T00:00:02.000Z"),
      },
    ];
    const messages = projectAgentMessagesFromPiHistory(rows);
    const tools = messages[0]?.tools ?? [];
    assert.equal(tools.find((t) => t.id === "ok")?.status, "done");
    assert.equal(tools.find((t) => t.id === "ok")?.output, "ok body");
    assert.equal(tools.find((t) => t.id === "missing")?.status, "error");
    assert.equal(tools.find((t) => t.id === "missing")?.output, "Interrupted");
  });
});
