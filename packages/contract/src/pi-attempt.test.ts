import assert from "node:assert/strict";
import test from "node:test";
import { PiAttemptInputSchema, PiAttemptOutcomeSchema } from "./pi-attempt.js";

const digest = "a".repeat(64);
const timestamp = "2026-07-28T00:00:00.000Z";
const workspace = {
  id: "workspace-1",
  name: "Demo",
  rootPath: "/workspace",
  sources: [{ id: "source", path: "/source" }],
  model: { id: "provider/model" },
  publicationPath: "/workspace/wiki",
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
});
