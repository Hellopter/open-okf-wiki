import assert from "node:assert/strict";
import test from "node:test";
import {
  AttemptMetricsSchema,
  ResolveGateCommandSchema,
  RunCommandKeySchema,
  RunCommandSchema,
  WikiRunAttemptSchema,
  WikiRunAttemptTranscriptDoneFrameSchema,
  WikiRunAttemptTranscriptErrorFrameSchema,
  WikiRunAttemptTranscriptSchema,
  WikiRunAttemptTranscriptTraceFrameSchema,
  WikiRunCommandResponseSchema,
  WikiRunEffectSchema,
  WikiRunEventSchema,
  WikiRunGetResponseSchema,
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

test("StartRun intent requires an explicit mode", () => {
  assert.equal(
    RunCommandSchema.safeParse({
      type: "start_run",
      commandId: "command-focus",
      intent: { focus: "Runtime and publication seams" },
    }).success,
    false,
  );
});

test("gate commands admit only their typed decisions", () => {
  const base = {
    type: "resolve_gate",
    commandId: "command-1",
    runId: "run-1",
    expectedRevision: 2,
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
  assert.equal(
    ResolveGateCommandSchema.safeParse({
      type: "resolve_gate",
      commandId: "command-1",
      runId: "run-1",
      gateId: "gate-1",
      gateKind: "plan",
      payloadDigest: digest,
      decision: "approve",
    }).success,
    false,
    "existing-Run commands require an expected control revision",
  );
});

test("review commands allow the server to compute the selected text digest", () => {
  assert.equal(
    RunCommandSchema.safeParse({
      type: "create_review_thread",
      commandId: "command-review",
      runId: "run-1",
      expectedRevision: 2,
      anchor: {
        candidateDigest: digest,
        pagePath: "overview.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Clarify the introductory example.",
    }).success,
    true,
  );
});

test("run events carry one matching full snapshot", () => {
  const snapshot = {
    schema: "okf.wiki-runs/v5",
    definitionVersion: 5,
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
  // Soft mid-run metrics refresh event (SSE projection only).
  assert.equal(
    WikiRunEventSchema.safeParse({
      runId: "run-1",
      eventId: 2,
      revision: 2,
      type: "attempt.progress",
      occurredAt: timestamp,
      snapshot,
    }).success,
    true,
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

test("WikiRuns HTTP response and transcript SSE frames are strict", () => {
  const snapshot = {
    schema: "okf.wiki-runs/v5",
    definitionVersion: 5,
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
  };
  assert.equal(WikiRunGetResponseSchema.safeParse({ snapshot, cursor: 2 }).success, true);
  assert.equal(WikiRunGetResponseSchema.safeParse({ snapshot, cursor: -1 }).success, false);
  const traceEvent = {
    trace: 1,
    ordinal: 1,
    at: timestamp,
    kind: "assistant",
    content: "Working",
  };
  const transcript = {
    attemptId: "attempt-1",
    nodeKey: "plan",
    state: "succeeded",
    events: [traceEvent],
    hasEarlier: false,
    hasMore: false,
    cursor: 1,
  };
  assert.equal(WikiRunAttemptTranscriptSchema.safeParse(transcript).success, true);
  assert.equal(
    WikiRunAttemptTranscriptSchema.safeParse({ ...transcript, extra: true }).success,
    false,
  );
  assert.equal(
    WikiRunCommandResponseSchema.safeParse({
      receipt: { commandId: "command-1", runId: "run-1", revision: 2, accepted: true },
    }).success,
    true,
  );
  const trace = {
    attemptId: "attempt-1",
    nodeKey: "plan",
    state: "running",
    events: [traceEvent],
    cursor: 1,
    live: true,
  };
  assert.equal(WikiRunAttemptTranscriptTraceFrameSchema.safeParse(trace).success, true);
  assert.equal(
    WikiRunAttemptTranscriptTraceFrameSchema.safeParse({ ...trace, extra: true }).success,
    false,
  );
  assert.equal(
    WikiRunAttemptTranscriptDoneFrameSchema.safeParse({
      attemptId: "attempt-1",
      state: "succeeded",
      cursor: 1,
    }).success,
    true,
  );
  assert.equal(
    WikiRunAttemptTranscriptErrorFrameSchema.safeParse({ message: "trace failed" }).success,
    true,
  );
  assert.equal(WikiRunAttemptTranscriptErrorFrameSchema.safeParse({ message: "" }).success, false);
});
