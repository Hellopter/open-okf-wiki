import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolCall, WikiRunListItem } from "@okf-wiki/contract";
import { runIdFromToolReceipt, sessionRunLinks } from "./session-run-links.ts";

const run = (runId: string, sessionId?: string): WikiRunListItem => ({
  runId,
  ...(sessionId ? { sessionId } : {}),
  state: "running",
  updatedAt: "2026-08-02T12:00:00.000Z",
  revision: 1,
  attention: "none",
  completedNodes: 1,
  totalNodes: 5,
});

test("sessionRunLinks only exposes the durable Runs created by the active Session", () => {
  assert.deepEqual(
    sessionRunLinks([run("run-a", "session-a"), run("run-b", "session-b")], "session-a"),
    [
      {
        runId: "run-a",
        state: "running",
        updatedAt: "2026-08-02T12:00:00.000Z",
        attention: "none",
      },
    ],
  );
  assert.deepEqual(sessionRunLinks([run("run-a", "session-a")], null), []);
});

test("runIdFromToolReceipt links the Run-owning tool receipts", () => {
  const produced: AgentToolCall = {
    id: "tool-1",
    name: "wiki_produce",
    status: "done",
    details: { status: "accepted", runId: "run-a" },
  };
  assert.equal(runIdFromToolReceipt(produced), "run-a");
  assert.equal(runIdFromToolReceipt({ ...produced, name: "read" }), undefined);
  assert.equal(runIdFromToolReceipt({ ...produced, details: { status: "accepted" } }), undefined);
  assert.equal(
    runIdFromToolReceipt({
      id: "tool-2",
      name: "wiki_repair",
      status: "done",
      args: { runId: "run-a", nodeKey: "write.root" },
    }),
    "run-a",
  );
});
