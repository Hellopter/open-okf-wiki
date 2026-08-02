import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentSseEventSchema,
  applySessionStreamPatch,
  createSessionStreamState,
  diffSessionStreamState,
  SessionMessageSchema,
  SessionStreamStateSchema,
} from "./index.js";

test("Session DTO rejects Pi-only thinking, parts, raw tool args, and raw tool output", () => {
  const base = {
    id: "assistant-1",
    role: "assistant",
    content: "safe answer",
    createdAt: "2026-08-02T00:00:00.000Z",
    status: "done",
  } as const;
  assert.equal(SessionMessageSchema.safeParse({ ...base, thinking: "private" }).success, false);
  assert.equal(SessionMessageSchema.safeParse({ ...base, parts: [] }).success, false);
  assert.equal(
    SessionMessageSchema.safeParse({
      ...base,
      tools: [{ id: "tool-1", name: "read_file", status: "done", args: { path: "/secret" } }],
    }).success,
    false,
  );
  assert.equal(
    SessionMessageSchema.safeParse({
      ...base,
      tools: [{ id: "tool-1", name: "read_file", status: "done", output: "private result" }],
    }).success,
    false,
  );
});

test("Session snapshot is complete and a patch can safely replay from it", () => {
  const initial = createSessionStreamState([
    {
      id: "user-1",
      role: "user",
      content: "build it",
      createdAt: "2026-08-02T00:00:00.000Z",
      status: "done",
    },
  ]);
  const next = {
    ...initial,
    streamingMessage: {
      id: "assistant-1",
      role: "assistant" as const,
      content: "Working",
      createdAt: "2026-08-02T00:00:01.000Z",
      status: "streaming" as const,
      tools: [
        {
          id: "tool-1",
          name: "wiki_produce",
          status: "running" as const,
          receipt: { status: "accepted", summary: "Dispatching durable Wiki Run" },
        },
      ],
    },
    lastAssistantId: "assistant-1",
    turnActive: true,
    agentStatus: "streaming" as const,
    contextPhase: "normal" as const,
    sessionUsage: { contextTokens: 100 },
  };
  const parsed = SessionStreamStateSchema.parse(next);
  const patch = diffSessionStreamState(initial, parsed);
  assert.deepEqual(applySessionStreamPatch(initial, patch), parsed);

  assert.equal(
    AgentSseEventSchema.safeParse({
      source: "server",
      kind: "snapshot",
      sessionId: "s1",
      timestamp: "2026-08-02T00:00:00.000Z",
      payload: { session: { id: "s1", workspaceId: "w1" }, state: parsed },
    }).success,
    true,
  );
});
