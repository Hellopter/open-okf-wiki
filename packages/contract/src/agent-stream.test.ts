import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "./agent-message.js";
import {
  applySnapshotWithActiveTool,
  createPiStreamState,
  reducePiEvent,
  updateToolInState,
  viewMessages,
} from "./agent-stream.js";

const ts = "2026-07-27T00:00:00.000Z";

function assistantWithTools(
  id: string,
  tools: NonNullable<AgentMessage["tools"]>,
  extra: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    id,
    role: "assistant",
    content: extra.content ?? "",
    createdAt: extra.createdAt ?? ts,
    status: extra.status ?? "done",
    tools,
    parts: tools.map((t) => ({ type: "tool" as const, toolId: t.id })),
    ...extra,
  };
}

describe("updateToolInState", () => {
  it("finds tool on older assistant when lastAssistantId is cleared", () => {
    const older = assistantWithTools("asst_old", [
      { id: "tool-old", name: "read", status: "pending" },
    ]);
    const newer = assistantWithTools("asst_new", [], { content: "later turn" });
    let state = createPiStreamState([older, newer]);
    // Simulate agent_start / reconnect where the pointer no longer targets the tool owner.
    state = { ...state, lastAssistantId: null, streamingMessage: null };

    state = updateToolInState(state, "tool-old", {
      status: "done",
      output: "file body",
      name: "read",
    });

    assert.equal(state.streamingMessage, null);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0]?.tools?.[0]?.id, "tool-old");
    assert.equal(state.messages[0]?.tools?.[0]?.status, "done");
    assert.equal(state.messages[0]?.tools?.[0]?.output, "file body");
    // Must not invent a second assistant shell for the same toolCallId.
    assert.equal(
      state.messages.flatMap((m) => m.tools ?? []).filter((t) => t.id === "tool-old").length,
      1,
    );
  });

  it("prefers streamingMessage when it already owns the toolCallId", () => {
    const durable = assistantWithTools("asst_old", [
      { id: "other", name: "bash", status: "done", output: "ok" },
    ]);
    let state = createPiStreamState([durable]);
    state = {
      ...state,
      streamingMessage: assistantWithTools(
        "asst_live",
        [{ id: "live-tool", name: "read", status: "pending" }],
        { status: "streaming" },
      ),
      lastAssistantId: "asst_live",
    };

    state = updateToolInState(state, "live-tool", { status: "running" });
    assert.equal(state.streamingMessage?.tools?.[0]?.status, "running");
    assert.equal(state.messages[0]?.tools?.[0]?.status, "done");
  });

  it("does not create a duplicate shell when lastAssistantId points at a different message", () => {
    const owner = assistantWithTools("asst_owner", [
      { id: "shared-id", name: "wiki_produce", status: "running" },
    ]);
    const other = assistantWithTools("asst_other", [], { content: "no tools" });
    let state = createPiStreamState([owner, other]);
    state = { ...state, lastAssistantId: "asst_other", streamingMessage: null };

    state = updateToolInState(state, "shared-id", {
      status: "done",
      output: "Published",
    });

    assert.equal(state.streamingMessage, null);
    assert.equal(state.messages[0]?.tools?.[0]?.status, "done");
    assert.equal(state.messages[0]?.tools?.[0]?.output, "Published");
    assert.equal(state.messages[1]?.tools?.length ?? 0, 0);
  });
});

describe("applySnapshotWithActiveTool", () => {
  it("marks orphan incomplete tools error and restores activeTool as running", () => {
    const messages: AgentMessage[] = [
      assistantWithTools("asst-1", [
        { id: "orphan", name: "bash", status: "pending" },
        { id: "live", name: "wiki_produce", status: "pending" },
      ]),
    ];

    const state = applySnapshotWithActiveTool(
      messages,
      {
        toolCallId: "live",
        toolName: "wiki_produce",
        details: {
          status: "awaiting_plan",
          runId: "run-1",
          summary: "Awaiting plan",
        },
      },
      { toolCallId: "live", runId: "run-1", gate: "plan" },
    );

    const tools = viewMessages(state).flatMap((m) => m.tools ?? []);
    const orphan = tools.find((t) => t.id === "orphan");
    const live = tools.find((t) => t.id === "live");

    assert.equal(orphan?.status, "error");
    assert.equal(orphan?.output, "Interrupted");
    assert.equal(live?.status, "running");
    assert.equal(live?.details?.status, "awaiting_plan");
    assert.equal(live?.output, "Awaiting plan");
    assert.equal(state.turnActive, true);
    assert.equal(state.agentStatus, "streaming");
    // ADR 0035: Session stream never owns HITL waiters.
    assert.equal(state.pendingGate, null);
  });

  it("finalizes incomplete tools even when activeTool is absent", () => {
    const messages: AgentMessage[] = [
      assistantWithTools("asst-1", [{ id: "stuck", name: "read", status: "running" }]),
    ];
    const state = applySnapshotWithActiveTool(messages, null);
    assert.equal(state.messages[0]?.tools?.[0]?.status, "error");
    assert.equal(state.messages[0]?.tools?.[0]?.output, "Interrupted");
    assert.equal(state.turnActive, false);
    assert.equal(state.agentStatus, "idle");
    assert.equal(state.pendingGate, null);
  });

  it("clears pendingGate when snapshot omits it", () => {
    const messages: AgentMessage[] = [
      assistantWithTools("asst-1", [
        {
          id: "stale",
          name: "wiki_produce",
          status: "running",
          details: { status: "awaiting_plan", runId: "run-old" },
        },
      ]),
    ];
    const state = applySnapshotWithActiveTool(messages, null, null);
    assert.equal(state.pendingGate, null);
  });
});

describe("pendingGate hard-cut (ADR 0035)", () => {
  it("never sets pendingGate from wiki_produce tool details (gates are WikiRuns)", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "wiki-1",
      toolName: "wiki_produce",
      args: {},
    });
    state = reducePiEvent(state, "tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "wiki-1",
      toolName: "wiki_produce",
      partialResult: {
        details: {
          status: "accepted",
          runId: "run-1",
          summary: "Wiki Run accepted",
        },
      },
    });
    assert.equal(state.pendingGate, null);

    state = reducePiEvent(state, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "wiki-1",
      toolName: "wiki_produce",
      result: { details: { status: "accepted", runId: "run-1" } },
    });
    assert.equal(state.pendingGate, null);
  });

  it("keeps pendingGate null across agent_end", () => {
    let state = createPiStreamState();
    state = {
      ...state,
      turnActive: true,
      agentStatus: "streaming",
    };
    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.pendingGate, null);
  });
});

describe("wiki_produce receipt details on stream (no Session HITL)", () => {
  it("projects accepted receipt details without Session gate", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "wiki_produce",
      args: {},
    });
    state = reducePiEvent(state, "tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "wiki_produce",
      partialResult: {
        details: { status: "accepted", runId: "r1", summary: "ok" },
      },
    });
    assert.equal(state.pendingGate, null);
    const tool = viewMessages(state)
      .flatMap((m) => m.tools ?? [])
      .find((t) => t.id === "t1");
    assert.equal(tool?.details?.status, "accepted");
    assert.equal(tool?.details?.runId, "r1");
  });

  it("stream state pendingGate is always null", () => {
    assert.equal(createPiStreamState().pendingGate, null);
  });
});

describe("reducePiEvent agent_end", () => {
  it("finalizes still-running tools before settling", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t-run", name: "bash", arguments: { cmd: "sleep" } }],
      },
    });
    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "t-run",
      toolName: "bash",
      args: { cmd: "sleep" },
    });
    assert.equal(state.streamingMessage?.tools?.[0]?.status, "running");

    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.streamingMessage, null);
    assert.equal(state.turnActive, false);
    assert.equal(state.agentStatus, "idle");
    const tool = state.messages.at(-1)?.tools?.[0];
    assert.equal(tool?.id, "t-run");
    assert.equal(tool?.status, "error");
    assert.equal(tool?.output, "Interrupted");
  });

  it("finalizes pending tools already on durable messages", () => {
    let state = createPiStreamState([
      assistantWithTools("asst-1", [{ id: "left-pending", name: "read", status: "pending" }]),
    ]);
    state = { ...state, turnActive: true, agentStatus: "streaming" };
    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.messages[0]?.tools?.[0]?.status, "error");
    assert.equal(state.messages[0]?.tools?.[0]?.output, "Interrupted");
  });
});

describe("reducePiEvent tool_execution_start wiki_produce", () => {
  it("supersedes other non-terminal wiki_produce tools", () => {
    let state = createPiStreamState([
      assistantWithTools("asst-1", [
        { id: "old-produce", name: "wiki_produce", status: "running" },
        { id: "done-produce", name: "wiki_produce", status: "done", output: "Published" },
        { id: "other-tool", name: "bash", status: "running" },
      ]),
    ]);
    state = { ...state, lastAssistantId: "asst-1" };

    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "new-produce",
      toolName: "wiki_produce",
      args: { audience: "ops" },
    });

    const tools = viewMessages(state).flatMap((m) => m.tools ?? []);
    assert.equal(tools.find((t) => t.id === "old-produce")?.status, "error");
    assert.equal(
      tools.find((t) => t.id === "old-produce")?.output,
      "Superseded by a new wiki_produce",
    );
    assert.equal(tools.find((t) => t.id === "done-produce")?.status, "done");
    assert.equal(tools.find((t) => t.id === "other-tool")?.status, "running");
    assert.equal(tools.find((t) => t.id === "new-produce")?.status, "running");
    assert.equal(tools.find((t) => t.id === "new-produce")?.name, "wiki_produce");
  });

  it("keeps pendingGate null when superseding wiki_produce tools", () => {
    let state = createPiStreamState([
      assistantWithTools("asst-1", [
        { id: "old-produce", name: "wiki_produce", status: "running" },
      ]),
    ]);
    state = {
      ...state,
      lastAssistantId: "asst-1",
    };

    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "new-produce",
      toolName: "wiki_produce",
      args: {},
    });

    assert.equal(state.pendingGate, null);
    assert.equal(
      viewMessages(state)
        .flatMap((m) => m.tools ?? [])
        .find((t) => t.id === "old-produce")?.status,
      "error",
    );
  });
});
