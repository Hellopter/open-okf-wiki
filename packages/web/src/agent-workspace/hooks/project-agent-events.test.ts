import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { toolOutputFromResult } from "./project/format.ts";
import {
  createPiStreamState,
  projectAgentEvent,
  projectPiHistory,
  reducePiEvent,
  viewMessages,
} from "./project/pi.ts";
import type { AgentSseLike } from "./project/types.ts";

describe("projectAgentEvent", () => {
  it("uses the server snapshot as the complete durable AgentMessage view", () => {
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Produce the wiki",
            createdAt: "2026-07-24T00:00:00.001Z",
            status: "done",
          },
          {
            id: "asst-1",
            role: "assistant",
            content: "Starting ",
            createdAt: "2026-07-24T00:00:00.002Z",
            status: "done",
            tools: [
              {
                id: "wiki-1",
                name: "wiki_produce",
                args: { audience: "maintainers" },
                output: "published 4 pages",
                status: "done",
              },
            ],
          },
        ],
      },
    });

    const messages = viewMessages(state);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content, "Produce the wiki");
    assert.equal(messages[1]!.role, "assistant");
    assert.equal(messages[1]!.content, "Starting ");
    assert.deepEqual(messages[1]!.tools, [
      {
        id: "wiki-1",
        name: "wiki_produce",
        args: { audience: "maintainers" },
        output: "published 4 pages",
        status: "done",
      },
    ]);
  });

  it("replaces stale local state when EventSource reconnects with a fresh snapshot", () => {
    const stale = createPiStreamState([
      {
        id: "stale",
        role: "assistant",
        content: "stale replay copy",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "done",
      },
    ]);

    const next = projectAgentEvent(stale, {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "asst-durable",
            role: "assistant",
            content: "durable truth",
            createdAt: "2026-07-24T00:00:00.004Z",
            status: "done",
          },
        ],
      },
    });

    assert.deepEqual(
      viewMessages(next).map((message) => message.content),
      ["durable truth"],
    );
  });

  it("clears optimistic client rows when a server snapshot arrives", () => {
    const withOptimistic = createPiStreamState([
      {
        id: "opt_user",
        role: "user",
        content: "pending local send",
        createdAt: "2026-07-24T00:00:00.000Z",
        status: "done",
        optimistic: true,
      },
    ]);

    const next = projectAgentEvent(withOptimistic, {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:01.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "pending local send",
            createdAt: "2026-07-24T00:00:00.001Z",
            status: "done",
          },
          {
            id: "asst-1",
            role: "assistant",
            content: "ok",
            createdAt: "2026-07-24T00:00:00.002Z",
            status: "done",
          },
        ],
      },
    });

    const messages = viewMessages(next);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[0]!.content, "pending local send");
    assert.equal(messages[0]!.optimistic, undefined);
    assert.ok(!messages.some((m) => m.optimistic === true));
    assert.equal(messages[0]!.id, "user-1");
  });

  it("restores the genuine live wiki_produce gate from a reconnect snapshot", () => {
    const spec = defaultWikiRunSpec("Reconnect");
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "asst-1",
            role: "assistant",
            content: "",
            createdAt: "2026-07-24T00:00:00.002Z",
            status: "done",
            tools: [
              {
                id: "wiki-1",
                name: "wiki_produce",
                args: {},
                status: "running",
              },
            ],
          },
        ],
        activeTool: {
          toolCallId: "wiki-1",
          toolName: "wiki_produce",
          details: {
            status: "awaiting_plan",
            runId: "run-1",
            spec,
            summary: "Awaiting WikiRunSpec approval",
          },
        },
      },
    });

    const tool = viewMessages(state)[0]!.tools?.[0];
    assert.equal(tool?.id, "wiki-1");
    assert.equal(tool?.status, "running");
    assert.equal(tool?.details?.status, "awaiting_plan");
    assert.equal(tool?.details?.spec?.summary, spec.summary);
    // Snapshot activeTool uses the same toolOutputFromResult path as live updates.
    assert.equal(tool?.output, "Awaiting WikiRunSpec approval");
  });

  it("snapshot activeTool and live tool_execution_update share details.summary output", () => {
    const summary = "Awaiting WikiRunSpec approval";
    const spec = defaultWikiRunSpec("Parity");
    const details = {
      status: "awaiting_plan" as const,
      runId: "run-parity",
      spec,
      summary,
    };

    const fromSnapshot = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "asst-parity",
            role: "assistant",
            content: "",
            createdAt: "2026-07-24T00:00:00.002Z",
            status: "done",
            tools: [
              {
                id: "wiki-parity",
                name: "wiki_produce",
                args: {},
                status: "running",
              },
            ],
          },
        ],
        activeTool: {
          toolCallId: "wiki-parity",
          toolName: "wiki_produce",
          details,
        },
      },
    });

    let fromLive = createPiStreamState();
    fromLive = reducePiEvent(fromLive, "agent_start", { type: "agent_start" });
    fromLive = reducePiEvent(fromLive, "message_start", {
      type: "message_start",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "wiki-parity",
            name: "wiki_produce",
            arguments: {},
          },
        ],
      },
    });
    fromLive = reducePiEvent(fromLive, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "wiki-parity",
      toolName: "wiki_produce",
      args: {},
    });
    // Content text deliberately differs from summary — single derivation prefers summary.
    fromLive = reducePiEvent(fromLive, "tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "wiki-parity",
      partialResult: {
        content: [{ type: "text", text: "different content text" }],
        details,
      },
    });

    const snapshotOut = viewMessages(fromSnapshot)[0]!.tools?.[0]?.output;
    const liveOut = viewMessages(fromLive)[0]!.tools?.[0]?.output;
    assert.equal(snapshotOut, summary);
    assert.equal(liveOut, summary);
    assert.equal(snapshotOut, liveOut);
    assert.equal(toolOutputFromResult(undefined, details), summary);
    assert.equal(
      toolOutputFromResult({ content: [{ type: "text", text: "different content text" }], details }),
      summary,
    );
  });

  it("preserves server-projected message ids from snapshot", () => {
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "pi-user-42",
            role: "user",
            content: "hello",
            createdAt: "2026-07-24T00:00:00.001Z",
            status: "done",
          },
          {
            id: "pi-asst-99",
            role: "assistant",
            content: "hi",
            createdAt: "2026-07-24T00:00:00.002Z",
            status: "done",
          },
        ],
      },
    });
    const messages = viewMessages(state);
    assert.equal(messages[0]!.id, "pi-user-42");
    assert.equal(messages[1]!.id, "pi-asst-99");
  });

  it("ignores heartbeat", () => {
    const seed = createPiStreamState([
      {
        id: "one",
        role: "user",
        content: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "done",
      },
    ]);

    assert.equal(
      projectAgentEvent(seed, {
        source: "server",
        kind: "heartbeat",
        sessionId: "session-1",
        timestamp: "2026-07-24T00:00:00.000Z",
      }),
      seed,
    );
  });
});

describe("reducePiEvent", () => {
  it("keeps structured tool args as objects (no string round-trip)", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "read",
            arguments: { path: "src/main.ts", offset: 10 },
          },
        ],
      },
    });
    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "src/main.ts", offset: 10 },
    });

    const tool = viewMessages(state)[0]!.tools?.[0];
    assert.deepEqual(tool?.args, { path: "src/main.ts", offset: 10 });
    assert.equal(typeof tool?.args, "object");
    assert.equal(tool?.status, "running");
  });

  it("does not invent thinking chrome on empty message_update without open stream", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    const next = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "" },
    });

    assert.equal(next, state);
    assert.equal(next.streamingMessage, null);
    assert.equal(viewMessages(next).length, 0);
  });

  it("dedupes error events when assistant already carries the same errorText", () => {
    let state = createPiStreamState([
      {
        id: "asst_err",
        role: "assistant",
        content: "provider failed",
        createdAt: "2026-07-24T00:00:00.000Z",
        status: "error",
        errorText: "provider failed",
      },
    ]);
    state = { ...state, lastAssistantId: "asst_err" };

    const next = reducePiEvent(state, "error", {
      type: "error",
      message: "provider failed",
    });

    // No second system/assistant row — only agentStatus/errorText projection.
    assert.equal(next.messages, state.messages);
    assert.equal(viewMessages(next).length, 1);
    assert.equal(viewMessages(next)[0]!.role, "assistant");
    assert.equal(next.agentStatus, "error");
    assert.equal(next.errorText, "provider failed");

    // Already projected: further identical error events are referentially stable.
    const again = reducePiEvent(next, "error", {
      type: "error",
      message: "provider failed",
    });
    assert.equal(again, next);
  });

  it("clears lastAssistantId on agent_start so a new turn does not reuse prior assistant", () => {
    let state = createPiStreamState([
      {
        id: "prior_asst",
        role: "assistant",
        content: "previous turn",
        createdAt: "2026-07-24T00:00:00.000Z",
        status: "done",
      },
    ]);
    state = { ...state, lastAssistantId: "prior_asst", turnActive: false };

    const next = reducePiEvent(state, "agent_start", { type: "agent_start" });
    assert.equal(next.lastAssistantId, null);
    assert.equal(next.turnActive, true);
    assert.equal(next.streamingMessage, null);
    // Prior durable messages remain until snapshot replaces them.
    assert.equal(viewMessages(next).length, 1);
  });

  it("accepts durable wiki_produce toolResult without live Run mirrors", () => {
    let state = createPiStreamState();
    state = projectAgentEvent(state, {
      source: "pi",
      kind: "message_end",
      sessionId: "s1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "wiki_produce",
          content: [{ type: "text", text: "Wiki Run run-1: published" }],
          // Durable final shape: no spec/children/defects (Run Boundary owns those).
          details: {
            status: "published",
            runId: "run-1",
            pages: ["overview.md"],
            summary: "Published",
          },
        },
      },
    } as AgentSseLike);
    const tool =
      viewMessages(state).find((m) => m.role === "assistant")?.tools?.[0] ??
      viewMessages(state).flatMap((m) => m.tools ?? [])[0];
    // toolResult may attach to assistant tool list or stand alone depending on projector
    const details =
      tool?.details ??
      (viewMessages(state).find((m) => m.tools?.some((t) => t.name === "wiki_produce"))?.tools?.[0]
        ?.details as { status?: string; runId?: string; spec?: unknown } | undefined);
    // If projector maps toolResult into tools, assert lean durable fields.
    if (details) {
      assert.equal(details.status, "published");
      assert.equal(details.runId, "run-1");
      assert.equal(details.spec, undefined);
    }
  });

  it("projects full Pi message snapshots without appending transport deltas", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
      assistantMessageEvent: { type: "text_delta", delta: "Hel" },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      },
    });

    assert.equal(viewMessages(state).length, 1);
    assert.equal(viewMessages(state)[0]!.content, "Hello");
  });

  it("projects the real Pi tool lifecycle on its assistant message", () => {
    const spec = defaultWikiRunSpec("Fixture");
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
      },
    });
    state = reducePiEvent(state, "message_update", {
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "wiki_produce",
            arguments: { audience: "users" },
          },
        ],
      },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "wiki_produce",
            arguments: { audience: "users" },
          },
        ],
        stopReason: "toolUse",
      },
    });
    state = reducePiEvent(state, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "wiki_produce",
      args: { audience: "users" },
    });
    state = reducePiEvent(state, "tool_execution_update", {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: {
        content: [{ type: "text", text: "Awaiting WikiRunSpec approval" }],
        details: {
          status: "awaiting_plan",
          runId: "run-1",
          spec,
          graph: {
            topologyVersion: 1,
            topology: [{ nodeKey: "plan", kind: "plan", label: "Plan" }],
            attempts: [
              {
                attemptId: "plan",
                nodeKey: "plan",
                runIndex: 0,
                role: "plan",
                status: "done",
                summary: "Fixture default WikiRunSpec",
                items: [{ type: "text", text: "pages=1" }],
              },
            ],
          },
        },
      },
    });
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.status, "awaiting_plan");
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.spec?.pages[0]?.path, "overview.md");
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.graph?.attempts[0]?.role, "plan");
    assert.deepEqual(viewMessages(state)[0]!.tools?.[0]?.args, { audience: "users" });
    state = reducePiEvent(state, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "wiki_produce",
      result: {
        content: [{ type: "text", text: "published" }],
        // Durable final details: no spec/graph (Run Boundary owns job facts).
        details: {
          status: "published",
          runId: "run-1",
          pages: ["overview.md"],
          summary: "Published",
        },
      },
      isError: false,
    });

    const tool = viewMessages(state)[0]!.tools?.[0];
    assert.equal(tool?.name, "wiki_produce");
    assert.equal(tool?.status, "done");
    // Prefer details.summary over content[].text (single derivation).
    assert.equal(tool?.output, "Published");
    assert.deepEqual(tool?.args, { audience: "users" });
    assert.equal(tool?.details?.status, "published");
    assert.deepEqual(tool?.details?.pages, ["overview.md"]);
    assert.equal(tool?.details?.spec, undefined);
    assert.equal(tool?.details?.graph, undefined);
  });

  it("dedupes message_end with the same Pi id (no double-append)", () => {
    let state = createPiStreamState([
      {
        id: "pi-asst-stable",
        role: "assistant",
        content: "already from snapshot",
        createdAt: "2026-07-24T00:00:00.000Z",
        status: "done",
      },
    ]);
    state = { ...state, lastAssistantId: "pi-asst-stable" };

    const next = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        id: "pi-asst-stable",
        role: "assistant",
        content: [{ type: "text", text: "replayed different body" }],
        stopReason: "stop",
      },
    });

    assert.equal(viewMessages(next).length, 1);
    assert.equal(viewMessages(next)[0]!.id, "pi-asst-stable");
    // Id match wins over content inequality — do not append a second card.
    assert.equal(viewMessages(next)[0]!.content, "already from snapshot");
  });

  it("prefers Pi message id on live message_start when present", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: {
        id: "pi-live-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });
    assert.equal(state.streamingMessage?.id, "pi-live-1");
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        id: "pi-live-1",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        stopReason: "stop",
      },
    });
    assert.equal(viewMessages(state)[0]!.id, "pi-live-1");
  });

  it("projects agentStatus streaming on agent_start and idle on agent_end", () => {
    let state = createPiStreamState();
    assert.equal(state.agentStatus, "idle");
    assert.equal(state.errorText, null);

    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    assert.equal(state.agentStatus, "streaming");
    assert.equal(state.turnActive, true);
    assert.equal(state.errorText, null);

    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.agentStatus, "idle");
    assert.equal(state.turnActive, false);
    assert.equal(state.errorText, null);
  });

  it("projects agentStatus error + errorText from message_end provider failure", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "  rate limited  ",
      },
    });

    assert.equal(state.agentStatus, "error");
    assert.equal(state.errorText, "rate limited");
    assert.equal(viewMessages(state)[0]!.status, "error");

    // agent_end preserves error status (matches prior hook behavior).
    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.agentStatus, "error");
    assert.equal(state.errorText, "rate limited");
    assert.equal(state.turnActive, false);
  });

  it("projects errorText fallback when stopReason is error without provider text", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
      },
    });

    assert.equal(state.agentStatus, "error");
    assert.equal(state.errorText, "Agent response failed");
  });

  it("does not project error on operator abort (neutral outcome)", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "message_start", {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "partial" }] },
    });
    state = reducePiEvent(state, "message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "aborted",
      },
    });

    assert.equal(state.agentStatus, "streaming");
    assert.equal(state.errorText, null);
    assert.ok(viewMessages(state).some((m) => m.status === "aborted"));

    state = reducePiEvent(state, "agent_end", { type: "agent_end" });
    assert.equal(state.agentStatus, "idle");
    assert.equal(state.errorText, null);
  });

  it("projects agentStatus error from pi error events", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    state = reducePiEvent(state, "error", {
      type: "error",
      message: "transport failed",
    });

    assert.equal(state.agentStatus, "error");
    assert.equal(state.errorText, "transport failed");
    assert.equal(viewMessages(state).at(-1)?.role, "system");
  });

  it("clears prior stream error on a new agent_start", () => {
    let state = createPiStreamState();
    state = reducePiEvent(state, "error", {
      type: "error",
      message: "old failure",
    });
    assert.equal(state.agentStatus, "error");
    assert.equal(state.errorText, "old failure");

    state = reducePiEvent(state, "agent_start", { type: "agent_start" });
    assert.equal(state.agentStatus, "streaming");
    assert.equal(state.errorText, null);
  });

  it("snapshot with activeTool projects agentStatus streaming", () => {
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "asst-1",
            role: "assistant",
            content: "",
            createdAt: "2026-07-24T00:00:00.002Z",
            status: "done",
            tools: [
              {
                id: "wiki-1",
                name: "wiki_produce",
                args: {},
                status: "running",
              },
            ],
          },
        ],
        activeTool: {
          toolCallId: "wiki-1",
          toolName: "wiki_produce",
          details: {
            status: "running",
            runId: "run-1",
            summary: "Working",
          },
        },
      },
    });

    assert.equal(state.turnActive, true);
    assert.equal(state.agentStatus, "streaming");
    assert.equal(state.errorText, null);
  });

  it("idle snapshot projects agentStatus idle", () => {
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "hi",
            createdAt: "2026-07-24T00:00:00.001Z",
            status: "done",
          },
        ],
      },
    });

    assert.equal(state.turnActive, false);
    assert.equal(state.agentStatus, "idle");
    assert.equal(state.errorText, null);
  });
});

describe("toolOutputFromResult", () => {
  it("prefers details.summary over content text", () => {
    assert.equal(
      toolOutputFromResult(
        { content: [{ type: "text", text: "content path" }], details: { summary: "summary path" } },
        { summary: "summary path" },
      ),
      "summary path",
    );
  });

  it("peels result.details.summary when details arg is omitted", () => {
    assert.equal(
      toolOutputFromResult({
        content: [{ type: "text", text: "content path" }],
        details: { summary: "nested summary" },
      }),
      "nested summary",
    );
  });

  it("falls back to formatToolResultText when no summary", () => {
    assert.equal(
      toolOutputFromResult({ content: [{ type: "text", text: "only content" }] }),
      "only content",
    );
  });
});

describe("projectPiHistory", () => {
  it("uses Pi id for assistant rows when present", () => {
    const messages = projectPiHistory([
      {
        id: "hist-pi-1",
        role: "assistant",
        content: [{ type: "text", text: "durable" }],
        stopReason: "stop",
        timestamp: 10,
      },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.id, "hist-pi-1");
  });

  it("falls back to hist_asst_N without Pi id", () => {
    const messages = projectPiHistory([
      {
        role: "assistant",
        content: [{ type: "text", text: "no id" }],
        stopReason: "stop",
        timestamp: 10,
      },
    ]);
    assert.equal(messages[0]!.id, "hist_asst_1");
  });

  it("attaches toolResult output via toolOutputFromResult (summary preferred)", () => {
    const messages = projectPiHistory([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "t1",
            name: "wiki_produce",
            arguments: {},
          },
        ],
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "wiki_produce",
        content: [{ type: "text", text: "content body" }],
        details: {
          status: "published",
          runId: "run-1",
          pages: ["overview.md"],
          summary: "Published summary",
        },
        isError: false,
        timestamp: 2,
      },
    ]);
    assert.equal(messages[0]!.tools?.[0]?.output, "Published summary");
  });
});
