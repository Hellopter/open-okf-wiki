import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentSseEvent,
  createSessionStreamState,
  type SessionMessage,
  viewSessionMessages,
} from "@okf-wiki/contract";
import {
  appendOptimisticUser,
  dedupeOptimisticUsers,
  reduceSessionStreamEvent,
} from "./session-stream-state.ts";

const timestamp = "2026-08-02T00:00:00.000Z";

function assistant(
  id: string,
  content: string,
  status: SessionMessage["status"] = "done",
): SessionMessage {
  return { id, role: "assistant", content, createdAt: timestamp, status };
}

function user(id: string, content: string): SessionMessage {
  return { id, role: "user", content, createdAt: timestamp, status: "done" };
}

test("session stream patches retain historical messages while a live tail changes", () => {
  const history = assistant("history", "Published plan");
  const live = assistant("live", "Drafting", "streaming");
  const stream: AgentSseEvent = {
    source: "server",
    kind: "stream",
    sessionId: "session-1",
    timestamp,
    payload: {
      agentStatus: "streaming",
      errorText: null,
      turnActive: true,
      lastAssistantId: "live",
      streamingMessage: live,
      appended: [],
      updated: [],
      contextPhase: "normal",
    },
  };

  const next = reduceSessionStreamEvent(createSessionStreamState([history]), stream);

  assert.deepEqual(
    viewSessionMessages(next).map((message) => [message.id, message.content]),
    [
      ["history", "Published plan"],
      ["live", "Drafting"],
    ],
  );
});

test("dedupeOptimisticUsers drops optimistic rows when real user with same content arrives", () => {
  const optimistic = user("optimistic_user_1", "Hello agent");
  const real = user("user_server_42", "Hello agent");
  const history = assistant("asst_1", "Prior reply");

  const withBoth = createSessionStreamState([history, optimistic, real]);
  const deduped = dedupeOptimisticUsers(withBoth);

  assert.deepEqual(
    viewSessionMessages(deduped).map((message) => [message.id, message.role, message.content]),
    [
      ["asst_1", "assistant", "Prior reply"],
      ["user_server_42", "user", "Hello agent"],
    ],
  );
});

test("dedupeOptimisticUsers is one-to-one for identical prompts", () => {
  // Two optimistic sends of the same text; only one real yet → keep one optimistic.
  const opt1 = user("optimistic_user_1", "retry me");
  const opt2 = user("optimistic_user_2", "retry me");
  const real1 = user("user_server_1", "retry me");

  const partial = createSessionStreamState([opt1, opt2, real1]);
  const afterOne = dedupeOptimisticUsers(partial);
  const usersAfterOne = viewSessionMessages(afterOne).filter((m) => m.role === "user");

  assert.equal(usersAfterOne.length, 2);
  assert.equal(usersAfterOne.filter((m) => m.id.startsWith("optimistic_")).length, 1);
  assert.equal(usersAfterOne.filter((m) => !m.id.startsWith("optimistic_")).length, 1);

  // Second real arrives → both optimistics gone.
  const real2 = user("user_server_2", "retry me");
  const full = createSessionStreamState([...viewSessionMessages(afterOne), real2]);
  const afterTwo = dedupeOptimisticUsers(full);
  const usersAfterTwo = viewSessionMessages(afterTwo).filter((m) => m.role === "user");

  assert.equal(usersAfterTwo.length, 2);
  assert.ok(usersAfterTwo.every((m) => !m.id.startsWith("optimistic_")));
  assert.deepEqual(
    usersAfterTwo.map((m) => m.id),
    ["user_server_1", "user_server_2"],
  );
});

test("reduceSessionStreamEvent stream append replaces optimistic user with real row", () => {
  const optimisticState = appendOptimisticUser(createSessionStreamState(), "Ship the plan");
  assert.equal(viewSessionMessages(optimisticState).length, 1);
  assert.ok(viewSessionMessages(optimisticState)[0]!.id.startsWith("optimistic_"));

  const realUser = user("pi_user_9", "Ship the plan");
  const stream: AgentSseEvent = {
    source: "server",
    kind: "stream",
    sessionId: "session-1",
    timestamp,
    payload: {
      agentStatus: "streaming",
      errorText: null,
      turnActive: true,
      lastAssistantId: null,
      streamingMessage: null,
      appended: [realUser],
      updated: [],
      contextPhase: "normal",
    },
  };

  const next = reduceSessionStreamEvent(optimisticState, stream);
  const users = viewSessionMessages(next).filter((message) => message.role === "user");

  assert.equal(users.length, 1);
  assert.equal(users[0]!.id, "pi_user_9");
  assert.equal(users[0]!.content, "Ship the plan");
});

test("appendOptimisticUser ignores blank text and keeps distinct content", () => {
  let state = createSessionStreamState();
  state = appendOptimisticUser(state, "   ");
  assert.equal(viewSessionMessages(state).length, 0);

  state = appendOptimisticUser(state, " first ");
  state = appendOptimisticUser(state, "second");
  assert.deepEqual(
    viewSessionMessages(state).map((message) => message.content),
    ["first", "second"],
  );
  assert.ok(viewSessionMessages(state).every((message) => message.id.startsWith("optimistic_")));
});

test("reduceSessionStreamEvent tracks model from snapshot state and session chrome", () => {
  const empty = createSessionStreamState();

  // Prefer state.model when present (current servers project chrome onto state).
  const withStateModel: AgentSseEvent = {
    source: "server",
    kind: "snapshot",
    sessionId: "session-1",
    timestamp,
    payload: {
      session: {
        id: "session-1",
        workspaceId: "w1",
        model: { profileId: "envelope", modelId: "env-model" },
      },
      state: {
        ...createSessionStreamState(),
        model: { profileId: "state-profile", modelId: "state-model" },
        contextBudget: { contextWindow: 64_000, contextTarget: 54_400 },
      },
    },
  };
  const fromState = reduceSessionStreamEvent(empty, withStateModel);
  assert.equal(fromState.model?.profileId, "state-profile");
  assert.equal(fromState.contextBudget?.contextWindow, 64_000);

  // Phase 0 fallback: model only on payload.session when state omits it.
  const envelopeOnly: AgentSseEvent = {
    source: "server",
    kind: "snapshot",
    sessionId: "session-1",
    timestamp,
    payload: {
      session: {
        id: "session-1",
        workspaceId: "w1",
        model: { profileId: "envelope", modelId: "env-model" },
        contextBudget: { contextWindow: 32_000, contextTarget: 27_200 },
      },
      state: createSessionStreamState(),
    },
  };
  const fromEnvelope = reduceSessionStreamEvent(empty, envelopeOnly);
  assert.equal(fromEnvelope.model?.profileId, "envelope");
  assert.equal(fromEnvelope.contextBudget?.contextWindow, 32_000);
});

test("reduceSessionStreamEvent applies set_model chrome from stream patches", () => {
  const prior = reduceSessionStreamEvent(createSessionStreamState(), {
    source: "server",
    kind: "snapshot",
    sessionId: "session-1",
    timestamp,
    payload: {
      session: {
        id: "session-1",
        workspaceId: "w1",
        model: { profileId: "default", modelId: "gpt-a" },
      },
      state: {
        ...createSessionStreamState(),
        model: { profileId: "default", modelId: "gpt-a" },
        contextBudget: { contextWindow: 64_000, contextTarget: 54_400 },
        sessionUsage: { contextTokens: 100, contextWindow: 64_000, contextTarget: 54_400 },
      },
    },
  });
  assert.equal(prior.model?.profileId, "default");

  const setModelPatch: AgentSseEvent = {
    source: "server",
    kind: "stream",
    sessionId: "session-1",
    timestamp,
    payload: {
      agentStatus: "idle",
      errorText: null,
      turnActive: false,
      lastAssistantId: null,
      streamingMessage: null,
      appended: [],
      updated: [],
      contextPhase: "unknown",
      model: { profileId: "fast", modelId: "gpt-b", name: "Fast" },
      contextBudget: { contextWindow: 200_000, contextTarget: 170_000 },
      sessionUsage: { contextTokens: 100, contextWindow: 200_000, contextTarget: 170_000 },
    },
  };
  const after = reduceSessionStreamEvent(prior, setModelPatch);
  assert.equal(after.model?.profileId, "fast");
  assert.equal(after.model?.modelId, "gpt-b");
  assert.equal(after.contextBudget?.contextWindow, 200_000);
  assert.equal(after.sessionUsage?.contextWindow, 200_000);

  // Subsequent turn patch without chrome retains prior model.
  const turnOnly: AgentSseEvent = {
    source: "server",
    kind: "stream",
    sessionId: "session-1",
    timestamp,
    payload: {
      agentStatus: "streaming",
      errorText: null,
      turnActive: true,
      lastAssistantId: "a1",
      streamingMessage: assistant("a1", "hi", "streaming"),
      appended: [],
      updated: [],
      contextPhase: "normal",
    },
  };
  const retained = reduceSessionStreamEvent(after, turnOnly);
  assert.equal(retained.model?.profileId, "fast");
  assert.equal(retained.contextBudget?.contextWindow, 200_000);
});
