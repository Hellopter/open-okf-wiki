import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "./agent-message.js";
import {
  applySnapshotWithActiveTool,
  createPiStreamState,
  deriveContextPhase,
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

    const state = applySnapshotWithActiveTool(messages, {
      toolCallId: "live",
      toolName: "wiki_produce",
      details: {
        status: "accepted",
        runId: "run-1",
        summary: "Wiki Run accepted",
      },
    });

    const tools = viewMessages(state).flatMap((m) => m.tools ?? []);
    const orphan = tools.find((t) => t.id === "orphan");
    const live = tools.find((t) => t.id === "live");

    assert.equal(orphan?.status, "error");
    assert.equal(orphan?.output, "Interrupted");
    assert.equal(live?.status, "running");
    assert.equal(live?.details?.status, "accepted");
    assert.equal(live?.output, "Wiki Run accepted");
    assert.equal(state.turnActive, true);
    assert.equal(state.agentStatus, "streaming");
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
    const tool = viewMessages(state)
      .flatMap((m) => m.tools ?? [])
      .find((t) => t.id === "t1");
    assert.equal(tool?.details?.status, "accepted");
    assert.equal(tool?.details?.runId, "r1");
  });
});

describe("reducePiEvent agent_end vs agent_settled", () => {
  it("agent_end keeps turn active as between_operations (not idle)", () => {
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
    // Fold streaming tail; keep turn active — retry/compaction/queue may follow.
    assert.equal(state.streamingMessage, null);
    assert.equal(state.turnActive, true);
    assert.equal(state.agentStatus, "between_operations");
    const tool = state.messages.at(-1)?.tools?.[0];
    assert.equal(tool?.id, "t-run");
    // Incomplete tools are NOT finalized on agent_end (may continue).
    assert.equal(tool?.status, "running");
  });

  it("agent_settled finalizes incomplete tools and clears to idle", () => {
    let state = createPiStreamState([
      assistantWithTools("asst-1", [{ id: "left-pending", name: "read", status: "pending" }]),
    ]);
    state = { ...state, turnActive: true, agentStatus: "between_operations" };
    state = reducePiEvent(state, "agent_settled", { type: "agent_settled" });
    assert.equal(state.messages[0]?.tools?.[0]?.status, "error");
    assert.equal(state.messages[0]?.tools?.[0]?.output, "Interrupted");
    assert.equal(state.turnActive, false);
    assert.equal(state.agentStatus, "idle");
  });

  it("agent_settled preserves error status", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "error", { type: "error", message: "boom" });
    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.agentStatus, "error");
    assert.equal(state.turnActive, true);
    state = reducePiEvent(state, "agent_settled", { type: "agent_settled" });
    assert.equal(state.agentStatus, "error");
    assert.equal(state.turnActive, false);
    assert.equal(state.errorText, "boom");
  });

  it("compaction_start sets compacting phase; compaction_end returns between_operations", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    state = reducePiEvent(state, "compaction_start", {
      type: "compaction_start",
      reason: "threshold",
    });
    assert.equal(state.agentStatus, "compacting");
    assert.equal(state.contextPhase, "compacting");
    assert.equal(state.turnActive, true);
    state = reducePiEvent(state, "compaction_end", {
      type: "compaction_end",
      reason: "threshold",
      willRetry: false,
      aborted: false,
    });
    assert.equal(state.agentStatus, "between_operations");
    assert.equal(state.contextPhase, "unknown");
    assert.equal(state.turnActive, true);
  });
});

describe("deriveContextPhase", () => {
  it("maps compacting / thresholds / unknown", () => {
    assert.equal(deriveContextPhase({ compacting: true }), "compacting");
    assert.equal(deriveContextPhase({}), "unknown");
    assert.equal(deriveContextPhase({ contextTokens: 50, contextTarget: 100 }), "normal");
    assert.equal(
      deriveContextPhase({ contextTokens: 85, contextTarget: 100 }),
      "approaching_target",
    );
    assert.equal(deriveContextPhase({ contextTokens: 100, contextTarget: 100 }), "at_target");
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
});

describe("reducePiEvent user message_end", () => {
  it("agent_start then user message_end appends user to viewMessages", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    // message_start for user is intentionally a no-op
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "Hello operator" }],
      },
    });
    assert.equal(viewMessages(state).length, 0);

    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "Hello operator" }],
      },
    });

    const view = viewMessages(state);
    assert.equal(view.length, 1);
    assert.equal(view[0]?.role, "user");
    assert.equal(view[0]?.id, "user-1");
    assert.equal(view[0]?.content, "Hello operator");
    assert.equal(view[0]?.status, "done");
  });

  it("user then assistant stream + settle preserves user-then-assistant order", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        id: "user-1",
        role: "user",
        content: [{ type: "text", text: "What is status?" }],
      },
    });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        id: "asst-1",
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: {
        id: "asst-1",
        role: "assistant",
        content: [{ type: "text", text: "All green." }],
      },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        id: "asst-1",
        role: "assistant",
        content: [{ type: "text", text: "All green." }],
      },
    });
    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    state = reducePiEvent(state, "agent_settled", { type: "agent_settled" });

    const view = viewMessages(state);
    assert.equal(view.length, 2);
    assert.equal(view[0]?.role, "user");
    assert.equal(view[0]?.content, "What is status?");
    assert.equal(view[1]?.role, "assistant");
    assert.equal(view[1]?.content, "All green.");
    assert.equal(view[1]?.status, "done");
    assert.equal(state.agentStatus, "idle");
  });

  it("duplicate user message_end with same id is idempotent", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    const payload = {
      type: "message_end",
      message: {
        id: "user-dup",
        role: "user",
        content: [{ type: "text", text: "Once only" }],
      },
    };
    state = reducePiEvent(state, "message_end", payload);
    state = reducePiEvent(state, "message_end", payload);

    const users = viewMessages(state).filter((m) => m.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0]?.id, "user-dup");
    assert.equal(users[0]?.content, "Once only");
  });
});
