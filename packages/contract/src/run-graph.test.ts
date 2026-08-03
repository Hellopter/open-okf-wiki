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

test("NodeAttempt usage accepts context budget fields", () => {
  const parsed = NodeAttemptSchema.safeParse({
    attemptId: "plan",
    nodeKey: "plan",
    runIndex: 0,
    status: "running",
    usage: {
      turns: 2,
      contextTokens: 12_400,
      contextWindow: 128_000,
      contextTarget: 108_800,
    },
  });
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  assert.equal(parsed.data.usage?.contextTokens, 12_400);
  assert.equal(parsed.data.usage?.contextWindow, 128_000);
  assert.equal(parsed.data.usage?.contextTarget, 108_800);
});

test("NodeAttempt usage rejects non-positive window/target", () => {
  assert.equal(
    NodeAttemptSchema.safeParse({
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      status: "running",
      usage: { contextWindow: 0 },
    }).success,
    false,
  );
  assert.equal(
    NodeAttemptSchema.safeParse({
      attemptId: "plan",
      nodeKey: "plan",
      runIndex: 0,
      status: "running",
      usage: { contextTarget: -1 },
    }).success,
    false,
  );
});
