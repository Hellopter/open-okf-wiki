/**
 * Unit tests for mid-run progress → AttemptMetrics mapping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AttemptMetrics } from "@okf-wiki/contract";
import {
  forwardScopedProgress,
  progressMetricsFromScoped,
} from "./shared.js";

test("progressMetricsFromScoped maps contextTokens to inputTokens", () => {
  const metrics = progressMetricsFromScoped(
    {
      attemptId: "a1",
      nodeKey: "plan",
      runIndex: 0,
      status: "running",
      usage: {
        contextTokens: 12_400,
        contextWindow: 128_000,
        contextTarget: 108_800,
        turns: 2,
      },
    },
    { modelId: "provider/model", role: "plan" },
  );
  assert.deepEqual(metrics, {
    inputTokens: 12_400,
    modelId: "provider/model",
    role: "plan",
    extra: { contextWindow: 128_000, contextTarget: 108_800 },
  });
});

test("progressMetricsFromScoped omits inventable fields and terminal-only fields", () => {
  const metrics = progressMetricsFromScoped(
    {
      attemptId: "a1",
      nodeKey: "leaf",
      runIndex: 0,
      status: "running",
      usage: { turns: 1 },
    },
    { role: "leaf" },
  );
  assert.ok(metrics);
  assert.equal(metrics.role, "leaf");
  assert.equal("wallTimeMs" in metrics, false);
  assert.equal("stopReason" in metrics, false);
  assert.equal("inputTokens" in metrics, false);
});

test("progressMetricsFromScoped returns undefined when nothing projectable", () => {
  assert.equal(
    progressMetricsFromScoped({
      attemptId: "a1",
      nodeKey: "plan",
      runIndex: 0,
      status: "running",
    }),
    undefined,
  );
});

test("progressMetricsFromScoped counts toolCall items", () => {
  const metrics = progressMetricsFromScoped({
    attemptId: "a1",
    nodeKey: "leaf",
    runIndex: 0,
    status: "running",
    items: [
      { type: "text", text: "hi" },
      { type: "toolCall", name: "read", status: "done" },
      { type: "toolCall", name: "grep", status: "running" },
    ],
  });
  assert.equal(metrics?.toolCalls, 2);
});

test("progressMetricsFromScoped ignores non-positive window/target", () => {
  const metrics = progressMetricsFromScoped({
    usage: {
      contextTokens: 10,
      contextWindow: 0,
      contextTarget: -1,
    },
  });
  assert.deepEqual(metrics, { inputTokens: 10 });
});

test("forwardScopedProgress never throws and skips empty metrics", () => {
  const seen: AttemptMetrics[] = [];
  forwardScopedProgress(
    {
      onProgress: () => {
        throw new Error("sink boom");
      },
    },
    { usage: { contextTokens: 1 } },
    { role: "plan" },
  );
  forwardScopedProgress(
    {
      onProgress: (m) => {
        seen.push(m);
      },
    },
    { attemptId: "x", nodeKey: "x", runIndex: 0, status: "running" },
  );
  assert.equal(seen.length, 0);
  forwardScopedProgress(
    {
      onProgress: (m) => {
        seen.push(m);
      },
    },
    { usage: { contextTokens: 99 } },
    { role: "writer" },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.inputTokens, 99);
  assert.equal(seen[0]?.role, "writer");
});
