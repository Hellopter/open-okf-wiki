import assert from "node:assert/strict";
import test from "node:test";
import {
  executionClassForNodeKind,
  latestAttemptForNode,
  openGates,
  stageForNodeKind,
} from "./observe-wiki-run.js";
import type { WikiRunAttempt, WikiRunSnapshot } from "./wiki-runs.js";

const DIGEST = "a".repeat(64);

function attempt(
  partial: Pick<WikiRunAttempt, "attemptId" | "nodeKey" | "nodeGeneration" | "runIndex" | "startedAt">,
): WikiRunAttempt {
  return {
    ...partial,
    state: "succeeded",
    inputDigest: DIGEST,
    error: null,
    endedAt: partial.startedAt,
  };
}

test("stageForNodeKind buckets known kinds", () => {
  assert.equal(stageForNodeKind("plan"), "plan");
  assert.equal(stageForNodeKind("plan.scout"), "plan");
  assert.equal(stageForNodeKind("plan.discover.reduce"), "plan");
  assert.equal(stageForNodeKind("freeze"), "plan");
  assert.equal(stageForNodeKind("research.leaf"), "research");
  assert.equal(stageForNodeKind("plan.adapt"), "research");
  assert.equal(stageForNodeKind("write.root"), "write");
  assert.equal(stageForNodeKind("review.seat"), "review");
  assert.equal(stageForNodeKind("repair"), "repair");
  assert.equal(stageForNodeKind("validate.pre"), "validate");
  assert.equal(stageForNodeKind("validate.final"), "validate");
  assert.equal(stageForNodeKind("publish"), "publish");
  assert.equal(stageForNodeKind("prepare.publication"), "publish");
  assert.equal(stageForNodeKind("gate.plan"), "gate");
  assert.equal(stageForNodeKind("gate.fix"), "gate");
  assert.equal(stageForNodeKind("gate.publication"), "gate");
});

test("executionClassForNodeKind uses NodeContract registry", () => {
  assert.equal(executionClassForNodeKind("plan"), "pi");
  assert.equal(executionClassForNodeKind("write.root"), "pi");
  assert.equal(executionClassForNodeKind("freeze"), "mechanical");
  assert.equal(executionClassForNodeKind("validate.final"), "mechanical");
  assert.equal(executionClassForNodeKind("gate.plan"), "gate");
  assert.equal(executionClassForNodeKind("gate.fix"), "gate");
  assert.equal(executionClassForNodeKind("plan.scout"), "pi");
  assert.equal(executionClassForNodeKind("plan.discover.reduce"), "mechanical");
});

test("latestAttemptForNode prefers generation, then runIndex, then startedAt", () => {
  const attempts = [
    attempt({
      attemptId: "a1",
      nodeKey: "plan",
      nodeGeneration: 0,
      runIndex: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    attempt({
      attemptId: "a2",
      nodeKey: "plan",
      nodeGeneration: 0,
      runIndex: 2,
      startedAt: "2026-01-01T01:00:00.000Z",
    }),
    attempt({
      attemptId: "a3",
      nodeKey: "write.root",
      nodeGeneration: 0,
      runIndex: 1,
      startedAt: "2026-01-01T02:00:00.000Z",
    }),
    attempt({
      attemptId: "a4",
      nodeKey: "plan",
      nodeGeneration: 1,
      runIndex: 1,
      startedAt: "2026-01-01T03:00:00.000Z",
    }),
  ];
  assert.equal(latestAttemptForNode(attempts, "plan")?.attemptId, "a4");
  assert.equal(latestAttemptForNode(attempts, "write.root")?.attemptId, "a3");
  assert.equal(latestAttemptForNode(attempts, "missing"), undefined);
});

test("openGates returns only open gates", () => {
  const snapshot = {
    gates: [
      {
        gateId: "g1",
        nodeKey: "gate.plan",
        nodeGeneration: 0,
        kind: "plan" as const,
        state: "open" as const,
        payloadDigest: DIGEST,
        decision: null,
        openedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        gateId: "g2",
        nodeKey: "gate.fix",
        nodeGeneration: 0,
        kind: "fix" as const,
        state: "resolved" as const,
        payloadDigest: DIGEST,
        decision: {
          commandId: "cmd-1",
          decision: "pass",
          payloadDigest: DIGEST,
          decidedAt: "2026-01-01T01:00:00.000Z",
        },
        openedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        gateId: "g3",
        nodeKey: "gate.publication",
        nodeGeneration: 0,
        kind: "publication" as const,
        state: "withdrawn" as const,
        payloadDigest: DIGEST,
        decision: null,
        openedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  } as unknown as WikiRunSnapshot;

  const open = openGates(snapshot);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.gateId, "g1");
});
