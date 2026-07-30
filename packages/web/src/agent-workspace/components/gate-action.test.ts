import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WikiRunGate } from "@okf-wiki/contract";
import { buildGateActionResolveCommand, gateActionTitle } from "./gate-action.ts";

const copy = {
  planConfirm: { title: "Plan" },
  runStatus: { awaiting_publication: "Publish" },
  fixConfirm: { title: "Fix" },
  operatorInput: { title: "Answer" },
};
const digest = "b".repeat(64);

function gate(kind: WikiRunGate["kind"]): WikiRunGate {
  return {
    gateId: `gate-${kind}`,
    nodeKey: `node.${kind}`,
    nodeGeneration: 0,
    kind,
    state: "open",
    payloadDigest: digest,
    decision: null,
    openedAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("gateActionTitle", () => {
  it("uses the gate-specific operator prompt", () => {
    assert.equal(gateActionTitle("plan", copy), "Plan");
    assert.equal(gateActionTitle("publication", copy), "Publish");
    assert.equal(gateActionTitle("fix", copy), "Fix");
    assert.equal(gateActionTitle("operator_input", copy), "Answer");
  });
});

describe("buildGateActionResolveCommand", () => {
  it("keeps revise feedback and operator answers on their own command shapes", () => {
    const revise = buildGateActionResolveCommand({
      runId: "run-1",
      gate: gate("plan"),
      decision: "revise",
      feedback: "  Narrow the scope  ",
      commandId: "cmd-revise",
    });
    assert.equal(revise.gateKind, "plan");
    assert.equal(revise.feedback, "Narrow the scope");
    assert.equal("answer" in revise, false);

    const answer = buildGateActionResolveCommand({
      runId: "run-1",
      gate: gate("operator_input"),
      decision: "answer",
      answer: "  Use Chinese  ",
      commandId: "cmd-answer",
    });
    assert.equal(answer.gateKind, "operator_input");
    assert.equal(answer.answer, "Use Chinese");
    assert.equal("feedback" in answer, false);
  });

  it("rejects missing required gate input and routes fix gates to their specialist builder", () => {
    assert.throws(
      () =>
        buildGateActionResolveCommand({
          runId: "run-1",
          gate: gate("plan"),
          decision: "revise",
          commandId: "cmd-revise",
        }),
      /feedback/,
    );
    assert.throws(
      () =>
        buildGateActionResolveCommand({
          runId: "run-1",
          gate: gate("operator_input"),
          decision: "answer",
          commandId: "cmd-answer",
        }),
      /answer/,
    );
    assert.throws(
      () =>
        buildGateActionResolveCommand({
          runId: "run-1",
          gate: gate("fix"),
          decision: "deny",
          commandId: "cmd-fix",
        }),
      /fix gates/,
    );
  });
});
