import assert from "node:assert/strict";
import test from "node:test";
import {
  ResolveGateCommandSchema,
  RunCommandKeySchema,
  RunCommandSchema,
  WikiRunEffectSchema,
  WikiRunEventSchema,
} from "./wiki-runs.js";

const digest = "a".repeat(64);
const timestamp = "2026-07-28T00:00:00.000Z";

test("durable commands are strict and keyed by server-derived workspace context", () => {
  const command = { type: "start_run", commandId: "command-1" };
  assert.deepEqual(RunCommandSchema.parse(command), command);
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
});

test("run events carry one matching full snapshot", () => {
  const snapshot = {
    schema: "okf.wiki-runs/v1",
    definitionVersion: 1,
    runId: "run-1",
    workspaceId: "workspace-1",
    revision: 2,
    state: "queued",
    cancelRequested: false,
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
