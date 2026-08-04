import assert from "node:assert/strict";
import test from "node:test";
import {
  GateFailureSchema,
  PiAttemptFailureClassSchema,
  PiAttemptInputSchema,
  PiAttemptOutcomeSchema,
} from "./pi-attempt.js";

const digest = "a".repeat(64);
const timestamp = "2026-07-28T00:00:00.000Z";
const workspace = {
  version: 3,
  id: "workspace-1",
  name: "Demo",
  rootPath: "/workspace",
  sources: [{ id: "source", path: "/source", origin: { type: "path" } }],
  model: { id: "provider/model" },
  publicationPath: "/workspace/wiki",
  orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  createdAt: timestamp,
};

const input = {
  runId: "run-1",
  attemptId: "attempt-1",
  node: { key: "freeze", kind: "freeze", generation: 0, runIndex: 1 },
  inputDigest: digest,
  workspace,
  sealedInputs: [
    {
      role: "sources",
      artifact: { artifactId: "artifact-1", kind: "snapshot_set", digest, sealedAt: timestamp },
      readOnlyPath: "/workspace/artifacts/sources",
    },
  ],
  attemptDir: "/workspace/attempts/attempt-1",
  workDir: "/workspace/attempts/attempt-1/work",
  sessionPath: "/workspace/attempts/attempt-1/session.jsonl",
  skillPath: "/workspace/artifacts/skill",
  sourcePaths: { source: "/workspace/artifacts/sources/source" },
};

test("PiAttemptInput is strict, secret-free, and binds sealed inputs to absolute paths", () => {
  assert.equal(PiAttemptInputSchema.safeParse(input).success, true);
  assert.equal(
    PiAttemptInputSchema.safeParse({
      ...input,
      sealedInputs: [
        { ...input.sealedInputs[0], readOnlyPath: "C:\\workspace\\artifacts\\sources" },
      ],
    }).success,
    true,
  );
  assert.equal(PiAttemptInputSchema.safeParse({ ...input, cancel: true }).success, false);
  assert.equal(
    PiAttemptInputSchema.safeParse({ ...input, workspace: { ...workspace, apiKey: "secret" } })
      .success,
    false,
  );
  assert.equal(
    PiAttemptInputSchema.safeParse({
      ...input,
      sealedInputs: [{ ...input.sealedInputs[0], readOnlyPath: "relative/path" }],
    }).success,
    false,
  );
  assert.equal(
    PiAttemptInputSchema.safeParse({
      ...input,
      sealedInputs: [...input.sealedInputs, input.sealedInputs[0]],
    }).success,
    false,
  );
});

test("PiAttemptNode.detail accepts secret-free prompt fields and rejects unknown keys", () => {
  const withDetail = {
    ...input,
    node: {
      key: "research.leaf.core.1",
      kind: "research.leaf",
      generation: 0,
      runIndex: 1,
      detail: {
        domainId: "core",
        title: "Core",
        scope: "src/",
        question: "What is the entry point?",
        questionIndex: 1,
        questions: ["What is the entry point?", "What are the boundaries?"],
        lens: "grounding",
        critical: true,
        feedback: "Focus on runtime boundaries.",
      },
    },
  };
  assert.equal(PiAttemptInputSchema.safeParse(withDetail).success, true);
  assert.equal(
    PiAttemptInputSchema.safeParse({
      ...withDetail,
      node: {
        ...withDetail.node,
        detail: { ...withDetail.node.detail, apiKey: "secret" },
      },
    }).success,
    false,
  );
  assert.equal(
    PiAttemptInputSchema.safeParse({
      ...withDetail,
      node: {
        ...withDetail.node,
        detail: { questionIndex: 0 },
      },
    }).success,
    false,
  );
});

test("PiAttemptNode.detail accepts optional repairRequest", () => {
  const withRepair = {
    ...input,
    node: {
      key: "repair.1",
      kind: "repair",
      generation: 0,
      runIndex: 1,
      detail: {
        feedback: "Hard-validate repair (round 1/1):\noverview.md: boom",
        repairRequest: {
          requestId: "mech-repair:run-1:1",
          baselineCandidateId: "write.root",
          round: 1,
          sources: ["mechanical"],
          issues: [{ kind: "mechanical", message: "overview.md: boom" }],
          scope: { pages: ["overview.md"], mode: "patch" },
        },
      },
    },
  };
  const parsed = PiAttemptInputSchema.safeParse(withRepair);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.node.detail?.repairRequest?.requestId, "mech-repair:run-1:1");
    assert.deepEqual(parsed.data.node.detail?.repairRequest?.scope.pages, ["overview.md"]);
  }
  assert.equal(
    PiAttemptInputSchema.safeParse({
      ...withRepair,
      node: {
        ...withRepair.node,
        detail: {
          ...withRepair.node.detail,
          repairRequest: { requestId: "x" },
        },
      },
    }).success,
    false,
    "malformed repairRequest must fail closed",
  );
});

test("PiAttemptOutcome rejects malformed and cross-variant results", () => {
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "manifest", role: "result", sourcePath: "/work/result", directory: false },
      ],
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "gate_requested",
      question: "Which audience should this target?",
      transcript: {
        kind: "transcript",
        role: "transcript",
        sourcePath: "/work/session.jsonl",
        directory: false,
      },
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "cancelled",
      failureClass: "timeout",
    }).success,
    false,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "validation failed: missing type",
      failureClass: "schema",
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "gate_requested",
      question: "Continue?",
      transcript: {
        kind: "transcript",
        role: "transcript",
        sourcePath: "/work/session.jsonl",
        directory: true,
      },
    }).success,
    false,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "succeeded",
      unsealedArtifacts: [],
      error: "wrong variant",
    }).success,
    false,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "succeeded",
      unsealedArtifacts: [
        { kind: "manifest", role: "result", sourcePath: "/work/result", directory: false },
      ],
      metrics: { role: "plan", wallTimeMs: 12, stopReason: "succeeded", modelId: "p/m" },
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "boom",
      failureClass: "infrastructure",
      metrics: { role: "leaf", stopReason: "infrastructure", wallTimeMs: 3 },
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "coverage matrix incomplete",
      failureClass: "coverage_gap",
      gateFailure: {
        kind: "coverage",
        code: "coverage_gap",
        gaps: ["unit:src/entry", "unit:src/layout"],
        result: { stop_reason: "coverage_gap", ok: false },
      },
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "semantic sufficiency incomplete",
      failureClass: "semantic_gap",
      gateFailure: {
        kind: "semantic_sufficiency",
        gaps: ["facet:audience"],
      },
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "fanout rejected",
      failureClass: "schema",
      gateFailure: {
        kind: "spec_fanout",
        code: "spec_fanout",
      },
    }).success,
    true,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "gate failed",
      failureClass: "coverage_gap",
      gateFailure: {
        kind: "coverage",
        gaps: Array.from({ length: 65 }, (_, i) => `gap-${i}`),
      },
    }).success,
    false,
    "gateFailure.gaps must cap at 64",
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "gate failed",
      failureClass: "coverage_gap",
      gateFailure: {
        kind: "not_a_kind",
      },
    }).success,
    false,
  );
  assert.equal(
    PiAttemptOutcomeSchema.safeParse({
      type: "failed",
      error: "gate failed",
      failureClass: "coverage_gap",
      gateFailure: {
        kind: "coverage",
        extra: true,
      },
    }).success,
    false,
    "gateFailure is strict",
  );
});

test("PiAttemptFailureClass and GateFailure schemas export new gate classes", () => {
  for (const value of ["coverage_gap", "semantic_gap", "schema", "provider"] as const) {
    assert.equal(PiAttemptFailureClassSchema.safeParse(value).success, true, value);
  }
  assert.equal(PiAttemptFailureClassSchema.safeParse("timeout").success, false);

  const coverage = GateFailureSchema.safeParse({
    kind: "coverage",
    code: "coverage_gap",
    gaps: ["a"],
    result: { ok: false },
  });
  assert.equal(coverage.success, true);
  if (coverage.success) {
    assert.equal(coverage.data.kind, "coverage");
    assert.deepEqual(coverage.data.gaps, ["a"]);
  }

  assert.equal(
    GateFailureSchema.safeParse({ kind: "other" }).success,
    true,
    "minimal gateFailure is valid",
  );
});
