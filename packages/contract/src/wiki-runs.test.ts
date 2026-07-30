import assert from "node:assert/strict";
import test from "node:test";
import {
  AttemptMetricsSchema,
  ResolveGateCommandSchema,
  RunCommandKeySchema,
  RunCommandSchema,
  WikiRunAttemptSchema,
  WikiRunEffectSchema,
  WikiRunEventSchema,
} from "./wiki-runs.js";

const digest = "a".repeat(64);
const timestamp = "2026-07-28T00:00:00.000Z";

test("durable commands are strict and keyed by server-derived workspace context", () => {
  const command = {
    type: "start_run" as const,
    commandId: "command-1",
    intent: { mode: "generate" as const },
  };
  assert.deepEqual(RunCommandSchema.parse(command), command);
  assert.equal(
    RunCommandSchema.safeParse({ type: "start_run", commandId: "command-1" }).success,
    false,
    "bare start_run without intent must fail",
  );
  assert.equal(
    RunCommandSchema.safeParse({ ...command, workspaceId: "workspace-1" }).success,
    false,
  );
  assert.equal(RunCommandSchema.safeParse({ ...command, actor: { id: "client" } }).success, false);
  assert.deepEqual(
    RunCommandKeySchema.parse({ workspaceId: "workspace-1", commandId: "command-1" }),
    {
      workspaceId: "workspace-1",
      commandId: "command-1",
    },
  );
});

test("StartRun intent focus is optional; mode defaults to generate", () => {
  const parsed = RunCommandSchema.parse({
    type: "start_run",
    commandId: "command-focus",
    intent: { focus: "Runtime and publication seams" },
  });
  assert.equal(parsed.type, "start_run");
  if (parsed.type === "start_run") {
    assert.equal(parsed.intent.mode, "generate");
    assert.equal(parsed.intent.focus, "Runtime and publication seams");
  }
});

test("gate commands admit only their typed decisions", () => {
  const base = {
    type: "resolve_gate",
    commandId: "command-1",
    runId: "run-1",
    gateId: "gate-1",
    payloadDigest: digest,
  } as const;
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "plan", decision: "approve" }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "plan", decision: "revise" }).success,
    false,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({
      ...base,
      gateKind: "operator_input",
      decision: "answer",
      answer: "Use Chinese.",
    }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "publication", decision: "answer" })
      .success,
    false,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "fix", decision: "pass" }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "fix", decision: "deny" }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "fix", decision: "fix" }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({
      ...base,
      gateKind: "fix",
      decision: "fix",
      feedback: "Fix missing citations on overview",
    }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({
      ...base,
      gateKind: "fix",
      decision: "revise",
      feedback: "Tighten citations on overview.md",
    }).success,
    true,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "fix", decision: "revise" }).success,
    false,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "fix", decision: "approve" }).success,
    false,
  );
  assert.equal(
    ResolveGateCommandSchema.safeParse({ ...base, gateKind: "plan", decision: "pass" }).success,
    false,
  );
});

test("run events carry one matching full snapshot", () => {
  const snapshot = {
    schema: "okf.wiki-runs/v2",
    definitionVersion: 2,
    runId: "run-1",
    workspaceId: "workspace-1",
    revision: 2,
    state: "queued",
    cancelRequested: false,
    intent: { mode: "generate" as const },
    pinnedInputs: null,
    nodes: [],
    attempts: [],
    gates: [],
    effects: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
  assert.equal(
    WikiRunEventSchema.safeParse({
      runId: "run-1",
      eventId: 1,
      revision: 2,
      type: "run.started",
      occurredAt: timestamp,
      snapshot,
    }).success,
    true,
  );
  assert.equal(
    WikiRunEventSchema.safeParse({
      runId: "run-1",
      eventId: 1,
      revision: 3,
      type: "run.started",
      occurredAt: timestamp,
      snapshot,
    }).success,
    false,
  );
});

test("publication effects bind a candidate to its approved publication generation", () => {
  assert.equal(
    WikiRunEffectSchema.safeParse({
      effectKey: "publish:run-1:0:candidate",
      publicationNodeKey: "prepare.publication",
      publicationNodeGeneration: 0,
      gateId: "gate-publication-1",
      state: "prepared",
      requestDigest: digest,
      expectedLiveDigest: digest,
      candidateArtifactId: "candidate-artifact-1",
      candidateDigest: digest,
    }).success,
    true,
  );
});

test("AttemptMetrics accepts partial observation fields and rejects unknowns", () => {
  assert.equal(
    AttemptMetricsSchema.safeParse({
      role: "leaf",
      modelId: "provider/model",
      inputTokens: 10,
      outputTokens: 20,
      wallTimeMs: 1500,
      stopReason: "succeeded",
    }).success,
    true,
  );
  assert.equal(AttemptMetricsSchema.safeParse({}).success, true);
  assert.equal(AttemptMetricsSchema.safeParse({ inputTokens: -1 }).success, false);
  assert.equal(AttemptMetricsSchema.safeParse({ secret: "no" }).success, false);
});

test("WikiRunAttempt may include optional metrics", () => {
  const base = {
    attemptId: "attempt-1",
    nodeKey: "plan",
    nodeGeneration: 0,
    runIndex: 1,
    state: "succeeded",
    inputDigest: digest,
    error: null,
    startedAt: timestamp,
    endedAt: timestamp,
  } as const;
  assert.equal(WikiRunAttemptSchema.safeParse(base).success, true);
  assert.equal(
    WikiRunAttemptSchema.safeParse({
      ...base,
      metrics: { role: "plan", wallTimeMs: 42, stopReason: "succeeded" },
    }).success,
    true,
  );
});
