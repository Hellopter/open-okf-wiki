import assert from "node:assert/strict";
import test from "node:test";
import { AgentSseEventSchema } from "./agent-protocol.js";
import {
  applySessionStreamPatch,
  createSessionStreamState,
  diffSessionStreamState,
  SessionMessageSchema,
  SessionStreamStateSchema,
} from "./session-stream.js";

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
    model: { profileId: "default", modelId: "gpt-4o", name: "GPT-4o" },
    contextBudget: {
      contextWindow: 128_000,
      contextTarget: 108_800,
      reserveTokens: 19_200,
    },
  };
  const parsed = SessionStreamStateSchema.parse(next);
  const patch = diffSessionStreamState(initial, parsed);
  assert.deepEqual(applySessionStreamPatch(initial, patch), parsed);
  assert.equal(patch.model?.modelId, "gpt-4o");
  assert.equal(patch.contextBudget?.contextTarget, 108_800);

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

test("Session patch model/contextBudget is additive and retains prior when absent", () => {
  const withChrome = SessionStreamStateSchema.parse({
    ...createSessionStreamState(),
    model: { profileId: "a", modelId: "m-a" },
    contextBudget: { contextWindow: 10_000, contextTarget: 8_000 },
    sessionUsage: { contextTokens: 100, contextWindow: 10_000, contextTarget: 8_000 },
  });
  const turnOnly = diffSessionStreamState(withChrome, {
    ...withChrome,
    turnActive: true,
    agentStatus: "streaming",
    // Intentionally omit model/contextBudget on next → patch still re-emits when present on next
  });
  assert.equal(turnOnly.model?.profileId, "a");
  assert.equal(turnOnly.contextBudget?.contextWindow, 10_000);

  const clearedChromePatch = {
    agentStatus: "idle" as const,
    errorText: null,
    turnActive: false,
    lastAssistantId: null,
    streamingMessage: null,
    appended: [],
    updated: [],
    contextPhase: "normal" as const,
    // no model / contextBudget / sessionUsage
  };
  const retained = applySessionStreamPatch(withChrome, clearedChromePatch);
  assert.deepEqual(retained.model, withChrome.model);
  assert.deepEqual(retained.contextBudget, withChrome.contextBudget);
  assert.deepEqual(retained.sessionUsage, withChrome.sessionUsage);

  const switched = applySessionStreamPatch(withChrome, {
    ...clearedChromePatch,
    model: { profileId: "b", modelId: "m-b" },
    contextBudget: { contextWindow: 200_000, contextTarget: 170_000 },
    sessionUsage: { contextTokens: 100, contextWindow: 200_000, contextTarget: 170_000 },
  });
  assert.equal(switched.model?.profileId, "b");
  assert.equal(switched.contextBudget?.contextWindow, 200_000);
  assert.equal(switched.sessionUsage?.contextWindow, 200_000);
});
