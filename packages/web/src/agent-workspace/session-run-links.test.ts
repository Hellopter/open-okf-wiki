import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunListItem } from "@okf-wiki/contract";
import { sessionRunLinks } from "./session-run-links.ts";

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
