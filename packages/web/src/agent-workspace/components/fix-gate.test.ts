/**
 * Pure fix-gate helpers: ResolveGate payload + primary-gate selection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunGate, WikiRunSnapshot } from "@okf-wiki/contract";
import {
  buildFixGateResolveCommand,
  fixGateContextFromSnapshot,
  selectPrimaryOpenGate,
} from "./fix-gate.ts";

const digest = "b".repeat(64);
const timestamp = "2026-07-29T00:00:00.000Z";

function gate(partial: Partial<WikiRunGate> & Pick<WikiRunGate, "gateId" | "kind">): WikiRunGate {
  return {
    nodeKey: partial.nodeKey ?? `gate.${partial.kind}`,
    nodeGeneration: 0,
    state: "open",
    payloadDigest: digest,
    decision: null,
    openedAt: timestamp,
    ...partial,
  };
}

function snapshot(partial: Partial<WikiRunSnapshot> = {}): WikiRunSnapshot {
  return {
    schema: "okf.wiki-runs/v2",
    definitionVersion: 2,
    runId: "run-1",
    workspaceId: "ws-1",
    revision: 1,
    state: "waiting_for_operator",
    cancelRequested: false,
    intent: { mode: "generate" },
    pinnedInputs: null,
    nodes: [],
    attempts: [],
    gates: [],
    effects: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...partial,
  };
}

describe("buildFixGateResolveCommand", () => {
  it("builds pass / fix / deny without feedback", () => {
    for (const decision of ["pass", "fix", "deny"] as const) {
      const command = buildFixGateResolveCommand({
        runId: "run-1",
        gateId: "g-fix",
        payloadDigest: digest,
        decision,
        commandId: `cmd-${decision}`,
      });
      assert.equal(command.type, "resolve_gate");
      assert.equal(command.gateKind, "fix");
      assert.equal(command.decision, decision);
      assert.equal(command.gateId, "g-fix");
      assert.equal(command.payloadDigest, digest);
      assert.equal("feedback" in command, false);
    }
  });

  it("requires feedback for revise", () => {
    assert.throws(
      () =>
        buildFixGateResolveCommand({
          runId: "run-1",
          gateId: "g-fix",
          payloadDigest: digest,
          decision: "revise",
        }),
      /feedback/,
    );
    const command = buildFixGateResolveCommand({
      runId: "run-1",
      gateId: "g-fix",
      payloadDigest: digest,
      decision: "revise",
      feedback: "  Fix overview citations  ",
      commandId: "cmd-revise",
    });
    assert.equal(command.decision, "revise");
    assert.equal(command.feedback, "Fix overview citations");
  });
});

describe("selectPrimaryOpenGate", () => {
  it("prefers plan over fix over operator_input over publication", () => {
    const plan = gate({ gateId: "g-plan", kind: "plan" });
    const fix = gate({ gateId: "g-fix", kind: "fix" });
    const op = gate({ gateId: "g-op", kind: "operator_input", nodeKey: "plan" });
    const pub = gate({ gateId: "g-pub", kind: "publication" });
    assert.equal(selectPrimaryOpenGate([pub, fix, plan])?.gateId, "g-plan");
    assert.equal(selectPrimaryOpenGate([pub, fix])?.gateId, "g-fix");
    assert.equal(selectPrimaryOpenGate([pub, op])?.gateId, "g-op");
    assert.equal(selectPrimaryOpenGate([pub])?.gateId, "g-pub");
    assert.equal(selectPrimaryOpenGate([]), null);
  });

  it("ignores resolved gates", () => {
    const openFix = gate({ gateId: "g-fix", kind: "fix" });
    const resolvedPlan = gate({
      gateId: "g-plan",
      kind: "plan",
      state: "resolved",
      decision: {
        commandId: "c1",
        decision: "approve",
        payloadDigest: digest,
        decidedAt: timestamp,
      },
    });
    assert.equal(selectPrimaryOpenGate([resolvedPlan, openFix])?.kind, "fix");
  });
});

describe("fixGateContextFromSnapshot", () => {
  it("uses sealed defects report when provided", () => {
    const ctx = fixGateContextFromSnapshot(snapshot(), {
      defectsReport: {
        version: 1,
        clean: false,
        reviewerIds: ["r1"],
        summary: "Two blocking issues",
        defects: [
          {
            severity: "blocking",
            code: "citation.missing",
            path: "overview.md",
            issue: "No citation",
            reviewerId: "r1",
          },
        ],
      },
    });
    assert.equal(ctx.clean, false);
    assert.equal(ctx.summary, "Two blocking issues");
    assert.equal(ctx.defects.length, 1);
    assert.equal(ctx.defects[0]?.path, "overview.md");
  });

  it("falls back to attempt errors as defect hints", () => {
    const ctx = fixGateContextFromSnapshot(
      snapshot({
        attempts: [
          {
            attemptId: "a1",
            nodeKey: "validate.pre",
            nodeGeneration: 0,
            runIndex: 2,
            state: "failed",
            inputDigest: digest,
            error: "frontmatter missing title",
            failureClass: "schema",
            startedAt: timestamp,
            endedAt: timestamp,
          },
        ],
      }),
    );
    assert.equal(ctx.clean, false);
    assert.equal(ctx.defects.length, 1);
    assert.equal(ctx.defects[0]?.issue, "frontmatter missing title");
    assert.equal(ctx.defects[0]?.path, "validate.pre");
  });

  it("uses sealed gate.detail summary when present", () => {
    const openFix = gate({
      gateId: "g-fix",
      kind: "fix",
      detail: {
        source: "review",
        summary: "3 blocking from council",
        blockingCount: 3,
        clean: false,
      },
    });
    const ctx = fixGateContextFromSnapshot(snapshot(), { gate: openFix });
    assert.equal(ctx.summary, "3 blocking from council");
    assert.equal(ctx.clean, false);
  });
});
