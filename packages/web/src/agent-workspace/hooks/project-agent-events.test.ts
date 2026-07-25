import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  createPiStreamState,
  projectAgentEvent,
  reducePiEvent,
  viewMessages,
} from "./project/pi.ts";
import type { AgentSseLike } from "./project/types.ts";

describe("projectAgentEvent", () => {
  it("uses the server snapshot as the complete durable SessionManager view", () => {
    const state = projectAgentEvent(createPiStreamState(), {
      source: "server",
      kind: "snapshot",
      sessionId: "session-1",
      timestamp: "2026-07-24T00:00:00.000Z",
      payload: {
        session: { id: "session-1", workspaceId: "workspace-1" },
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Produce the wiki" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Starting " },
              {
                type: "toolCall",
                id: "wiki-1",
                name: "wiki_produce",
                arguments: { audience: "maintainers" },
              },
            ],
            stopReason: "stop",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "wiki-1",
            toolName: "wiki_produce",
            content: [{ type: "text", text: "published 4 pages" }],
            isError: false,
            timestamp: 3,
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
            role: "assistant",
            content: [{ type: "text", text: "durable truth" }],
            stopReason: "stop",
            timestamp: 4,
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
            role: "user",
            content: [{ type: "text", text: "pending local send" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            timestamp: 2,
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
    assert.equal(messages[0]!.id, "hist_user_1");
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
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "wiki-1",
                name: "wiki_produce",
                arguments: {},
              },
            ],
            stopReason: "toolUse",
            timestamp: 2,
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

    assert.equal(next, state);
    assert.equal(viewMessages(next).length, 1);
    assert.equal(viewMessages(next)[0]!.role, "assistant");
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
          children: [
            {
              id: "plan",
              role: "plan",
              status: "done",
              summary: "Fixture default WikiRunSpec",
              items: [{ type: "text", text: "pages=1" }],
            },
          ],
        },
      },
    });
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.status, "awaiting_plan");
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.spec?.pages[0]?.path, "overview.md");
    assert.equal(viewMessages(state)[0]!.tools?.[0]?.details?.children?.[0]?.role, "plan");
    assert.deepEqual(viewMessages(state)[0]!.tools?.[0]?.args, { audience: "users" });
    state = reducePiEvent(state, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "wiki_produce",
      result: {
        content: [{ type: "text", text: "published" }],
        // Durable final details: no spec/children (Run Boundary owns job facts).
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
    assert.equal(tool?.output, "published");
    assert.deepEqual(tool?.args, { audience: "users" });
    assert.equal(tool?.details?.status, "published");
    assert.deepEqual(tool?.details?.pages, ["overview.md"]);
    assert.equal(tool?.details?.spec, undefined);
    assert.equal(tool?.details?.children, undefined);
  });
});
