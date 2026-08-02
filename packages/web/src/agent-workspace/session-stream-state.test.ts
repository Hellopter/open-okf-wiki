import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentMessage,
  type AgentSseEvent,
  createPiStreamState,
  viewMessages,
} from "@okf-wiki/contract";
import { reduceSessionStreamEvent } from "./session-stream-state.ts";

const timestamp = "2026-08-02T00:00:00.000Z";

function assistant(
  id: string,
  content: string,
  status: AgentMessage["status"] = "done",
): AgentMessage {
  return { id, role: "assistant", content, createdAt: timestamp, status };
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
