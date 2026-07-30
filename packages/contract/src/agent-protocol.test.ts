import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSseEventSchema, parseAgentCommand, safeParseAgentCommand } from "./agent-protocol.js";

test("parseAgentCommand: prompt / steer / follow_up / abort / compact", () => {
  assert.equal(parseAgentCommand({ type: "prompt", text: "hello" }).type, "prompt");
  assert.equal(parseAgentCommand({ type: "steer", text: "stop" }).type, "steer");
  assert.equal(parseAgentCommand({ type: "follow_up", text: "later" }).type, "follow_up");
  assert.equal(parseAgentCommand({ type: "abort" }).type, "abort");
  assert.equal(parseAgentCommand({ type: "clear_queue" }).type, "clear_queue");
  assert.equal(parseAgentCommand({ type: "abort_compaction" }).type, "abort_compaction");
  assert.equal(parseAgentCommand({ type: "compact" }).type, "compact");
  assert.equal(parseAgentCommand({ type: "compact", mode: "stop_and_compact" }).type, "compact");
});

test("parseAgentCommand: rejects removed start_wiki_run and resume_gate commands", () => {
  assert.equal(safeParseAgentCommand({ type: "start_wiki_run", notes: "generate" }).success, false);
  assert.equal(
    safeParseAgentCommand({
      type: "resume_gate",
      gate: "plan",
      action: "approve",
      runId: "run-1",
    }).success,
    false,
  );
});

test("parseAgentCommand: set_model", () => {
  assert.equal(parseAgentCommand({ type: "set_model", profileId: "default" }).type, "set_model");
});

test("parseAgentCommand: rejects unknown type and empty prompt", () => {
  // camelCase followUp is not the wire command (snake follow_up is).
  assert.equal(safeParseAgentCommand({ type: "followUp", text: "x" }).success, false);
  assert.equal(safeParseAgentCommand({ type: "prompt", text: "" }).success, false);
  assert.equal(safeParseAgentCommand({}).success, false);
});

test("AgentSseEventSchema: accepts snapshot, stream patches, and heartbeat only", () => {
  const snapshot = AgentSseEventSchema.parse({
    source: "server",
    kind: "snapshot",
    sessionId: "s1",
    timestamp: "2026-07-24T00:00:00.000Z",
    payload: {
      session: { id: "s1", workspaceId: "w1" },
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          createdAt: "2026-07-24T00:00:00.000Z",
          status: "done",
        },
      ],
      activeTool: {
        toolCallId: "tool-1",
        toolName: "wiki_produce",
        details: {
          status: "accepted",
          runId: "run-1",
          summary: "Wiki Run accepted",
        },
      },
      sessionUsage: {
        contextTokens: 12_400,
        contextWindow: 128_000,
        contextTarget: 108_800,
      },
    },
  });
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.source === "server" && snapshot.kind === "snapshot") {
    assert.equal(snapshot.payload.activeTool?.details.status, "accepted");
    assert.equal(snapshot.payload.sessionUsage?.contextTokens, 12_400);
    assert.equal("pendingGate" in snapshot.payload, false);
  }

  const stream = AgentSseEventSchema.parse({
    source: "server",
    kind: "stream",
    sessionId: "s1",
    timestamp: "2026-07-24T00:00:00.000Z",
    payload: {
      agentStatus: "idle",
      errorText: null,
      turnActive: false,
      lastAssistantId: null,
      streamingMessage: null,
      appended: [],
      updated: [],
      sessionUsage: { contextTokens: 2500, contextWindow: 128_000 },
    },
  });
  assert.equal(stream.kind, "stream");
  if (stream.source === "server" && stream.kind === "stream") {
    assert.equal(stream.payload.sessionUsage?.contextTokens, 2500);
  }

  const heartbeat = AgentSseEventSchema.parse({
    source: "server",
    kind: "heartbeat",
    sessionId: "s1",
    timestamp: "2026-07-24T00:00:00.000Z",
  });
  assert.equal(heartbeat.kind, "heartbeat");
});
