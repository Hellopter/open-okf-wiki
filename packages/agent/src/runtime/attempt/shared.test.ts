/**
 * Unit tests for mid-run progress → AttemptMetrics mapping
 * and failAttempt gateFailure passthrough (WP-B).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PiAttemptInput } from "@okf-wiki/contract/pi-attempt";
import type { AttemptMetrics } from "@okf-wiki/contract/wiki-runs";
import { WorkspaceConfigSchema } from "@okf-wiki/contract/workspace";
import {
  failAttempt,
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

test("failAttempt attaches optional gateFailure to the failed outcome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-fail-attempt-"));
  const attemptDir = path.join(root, "attempt");
  await mkdir(attemptDir, { recursive: true });
  const workspace = WorkspaceConfigSchema.parse({
    version: 3,
    id: "ws",
    name: "Fail Attempt",
    rootPath: root,
    sources: [
      {
        id: "main",
        path: path.join(root, "src"),
        applyDefaultIgnores: true,
        ignore: [],
        origin: { type: "path" },
      },
    ],
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    orchestration: { maxActiveRuns: 1, maxConcurrentAttempts: 2 },
    limits: { requestTimeoutSeconds: 30 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
  const input: PiAttemptInput = {
    runId: "run-1",
    attemptId: "a1",
    node: { key: "plan", kind: "plan", generation: 0, runIndex: 1 },
    inputDigest: "f".repeat(64),
    workspace,
    sealedInputs: [
      {
        role: "sources",
        readOnlyPath: path.join(root, "sources"),
        artifact: {
          artifactId: "art-sources",
          kind: "snapshot_set",
          digest: "a".repeat(64),
          sealedAt: new Date().toISOString(),
        },
      },
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: path.join(root, "skill"),
    sourcePaths: { main: path.join(root, "sources", "main") },
  };

  const outcome = await failAttempt(input, {
    error: new Error("semantic sufficiency gap: api, _cross_source"),
    failureClass: "semantic_gap",
    gateFailure: {
      kind: "semantic_sufficiency",
      code: "SEMANTIC_GAP",
      gaps: ["api", "_cross_source"],
      result: {
        ok: false,
        stop_reason: "semantic_gap",
        gaps: ["api", "_cross_source"],
        rows: [],
      },
    },
    task: "Plan WikiRunSpec",
  });

  assert.equal(outcome.type, "failed");
  if (outcome.type !== "failed") return;
  assert.equal(outcome.failureClass, "semantic_gap");
  assert.ok(outcome.gateFailure);
  assert.equal(outcome.gateFailure.kind, "semantic_sufficiency");
  assert.equal(outcome.gateFailure.code, "SEMANTIC_GAP");
  assert.deepEqual(outcome.gateFailure.gaps, ["api", "_cross_source"]);
  assert.ok(outcome.unsealedArtifacts?.some((a) => a.kind === "transcript"));
});

test("failAttempt without gateFailure keeps failed outcome string-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-fail-attempt-plain-"));
  const attemptDir = path.join(root, "attempt");
  await mkdir(attemptDir, { recursive: true });
  const workspace = WorkspaceConfigSchema.parse({
    version: 3,
    id: "ws",
    name: "Fail Attempt Plain",
    rootPath: root,
    sources: [
      {
        id: "main",
        path: path.join(root, "src"),
        applyDefaultIgnores: true,
        ignore: [],
        origin: { type: "path" },
      },
    ],
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    orchestration: { maxActiveRuns: 1, maxConcurrentAttempts: 2 },
    limits: { requestTimeoutSeconds: 30 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
  const input: PiAttemptInput = {
    runId: "run-1",
    attemptId: "a1",
    node: { key: "plan", kind: "plan", generation: 0, runIndex: 1 },
    inputDigest: "f".repeat(64),
    workspace,
    sealedInputs: [
      {
        role: "sources",
        readOnlyPath: path.join(root, "sources"),
        artifact: {
          artifactId: "art-sources",
          kind: "snapshot_set",
          digest: "a".repeat(64),
          sealedAt: new Date().toISOString(),
        },
      },
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: path.join(root, "skill"),
    sourcePaths: { main: path.join(root, "sources", "main") },
  };

  const outcome = await failAttempt(input, {
    error: new Error("provider boom"),
    failureClass: "provider",
  });
  assert.equal(outcome.type, "failed");
  if (outcome.type !== "failed") return;
  assert.equal(outcome.failureClass, "provider");
  assert.equal(outcome.gateFailure, undefined);
});
