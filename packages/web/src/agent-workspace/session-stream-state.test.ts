import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentMessage,
  type AgentSseEvent,
  createPiStreamState,
  viewMessages,
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
  status: AgentMessage["status"] = "done",
): AgentMessage {
  return { id, role: "assistant", content, createdAt: timestamp, status };
}

function user(id: string, content: string): AgentMessage {
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

  const next = reduceSessionStreamEvent(createPiStreamState([history]), stream);

  assert.deepEqual(
    viewMessages(next).map((message) => [message.id, message.content]),
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

  const withBoth = createPiStreamState([history, optimistic, real]);
  const deduped = dedupeOptimisticUsers(withBoth);

  assert.deepEqual(
    viewMessages(deduped).map((message) => [message.id, message.role, message.content]),
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

  const partial = createPiStreamState([opt1, opt2, real1]);
  const afterOne = dedupeOptimisticUsers(partial);
  const usersAfterOne = viewMessages(afterOne).filter((m) => m.role === "user");

  assert.equal(usersAfterOne.length, 2);
  assert.equal(usersAfterOne.filter((m) => m.id.startsWith("optimistic_")).length, 1);
  assert.equal(usersAfterOne.filter((m) => !m.id.startsWith("optimistic_")).length, 1);

  // Second real arrives → both optimistics gone.
  const real2 = user("user_server_2", "retry me");
  const full = createPiStreamState([...viewMessages(afterOne), real2]);
  const afterTwo = dedupeOptimisticUsers(full);
  const usersAfterTwo = viewMessages(afterTwo).filter((m) => m.role === "user");

  assert.equal(usersAfterTwo.length, 2);
  assert.ok(usersAfterTwo.every((m) => !m.id.startsWith("optimistic_")));
  assert.deepEqual(
    usersAfterTwo.map((m) => m.id),
    ["user_server_1", "user_server_2"],
  );
});

test("reduceSessionStreamEvent stream append replaces optimistic user with real row", () => {
  const optimisticState = appendOptimisticUser(createPiStreamState(), "Ship the plan");
  assert.equal(viewMessages(optimisticState).length, 1);
  assert.ok(viewMessages(optimisticState)[0]!.id.startsWith("optimistic_"));

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
  const users = viewMessages(next).filter((message) => message.role === "user");

  assert.equal(users.length, 1);
  assert.equal(users[0]!.id, "pi_user_9");
  assert.equal(users[0]!.content, "Ship the plan");
});

test("appendOptimisticUser ignores blank text and keeps distinct content", () => {
  let state = createPiStreamState();
  state = appendOptimisticUser(state, "   ");
  assert.equal(viewMessages(state).length, 0);

  state = appendOptimisticUser(state, " first ");
  state = appendOptimisticUser(state, "second");
  assert.deepEqual(
    viewMessages(state).map((message) => message.content),
    ["first", "second"],
  );
  assert.ok(viewMessages(state).every((message) => message.id.startsWith("optimistic_")));
});
