import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeAttemptSchema } from "./run-graph.js";

test("NodeAttempt rejects empty attemptId", () => {
  assert.equal(
    NodeAttemptSchema.safeParse({
      attemptId: "",
      nodeKey: "plan",
      runIndex: 0,
      status: "running",
    }).success,
    false,
  );
});
