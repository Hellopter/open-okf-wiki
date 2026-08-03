/**
 * Phase 4: durable operator_input HITL —
 * gate_requested → suspended/waiting/open gate → answer → new generation Attempt.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { PiAttemptInput, PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForRunState,
} from "./harness.js";

async function gateRequestedPlan(input: PiAttemptInput): Promise<PiAttemptOutcome> {
  await mkdir(input.workDir, { recursive: true });
  const transcript = path.join(input.attemptDir, "session.jsonl");
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(
    transcript,
    [
      JSON.stringify({ role: "assistant", content: "Need a fact from the operator." }),
      JSON.stringify({
        schema: 1,
        node: input.node.key,
        mode: "gate_requested",
        summary: "Need operator input",
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return {
    type: "gate_requested",
    question: "What is the primary audience for this wiki?",
    context: "Plan needs audience before drafting Spec pages.",
    transcript: {
      kind: "transcript",
      role: "transcript",
      sourcePath: transcript,
      directory: false,
    },
  };
}

test("gate_requested suspends attempt, opens operator_input, answer spawns new generation", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let planInvocations = 0;
  const seenOperatorInput: boolean[] = [];

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan") {
        planInvocations += 1;
        const hasOperatorInput = input.sealedInputs.some(
          (item) => item.role === "operator_input" || item.artifact.kind === "operator_input",
        );
        seenOperatorInput.push(hasOperatorInput);
        if (planInvocations === 1) {
          assert.equal(hasOperatorInput, false, "first plan attempt has no operator answer");
          return gateRequestedPlan(input);
        }
        assert.equal(hasOperatorInput, true, "continuation attempt must bind operator_input");
        // Prove materialize-facing bytes exist on the sealed path.
        const sealed = input.sealedInputs.find((item) => item.role === "operator_input");
        assert.ok(sealed);
        const answerRaw = await readFile(
          path.join(sealed!.readOnlyPath, "operator-input.json"),
          "utf8",
        );
        const answerJson = JSON.parse(answerRaw) as { answer?: string };
        assert.equal(answerJson.answer, "Platform engineers building local wiki runs");
        return succeededPlan(input);
      }
      if (input.node.kind === "freeze") {
        return fullGraphFixtureExecutor(input, signal);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-op-input", intent: { mode: "generate" } },
    context(workspaceId),
  );

  const waiting = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  assert.equal(waiting.snapshot.state, "waiting_for_operator");

  const suspended = waiting.snapshot.attempts.find((a) => a.state === "suspended");
  assert.ok(suspended, "producer attempt must be suspended (not failed)");
  assert.equal(suspended!.nodeKey, "plan");
  assert.equal(suspended!.nodeGeneration, 0);

  const planNode = waiting.snapshot.nodes.find((n) => n.key === "plan");
  assert.equal(planNode?.state, "waiting");
  assert.equal(planNode?.generation, 0);

  const gate = waiting.snapshot.gates.find(
    (g) => g.kind === "operator_input" && g.state === "open",
  );
  assert.ok(gate);
  assert.equal(gate!.nodeKey, "plan");
  assert.equal(gate!.nodeGeneration, 0);
  assert.equal(gate!.detail?.summary, "What is the primary audience for this wiki?");

  const resolveBody = {
    type: "resolve_gate" as const,
    commandId: "resolve-op-answer",
    runId: receipt.runId,
    expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
    gateId: gate!.gateId,
    gateKind: "operator_input" as const,
    payloadDigest: gate!.payloadDigest,
    decision: "answer" as const,
    answer: "Platform engineers building local wiki runs",
  };
  const resolved = await runs.dispatch(resolveBody, context(workspaceId));
  assert.equal(resolved.accepted, true);

  // Idempotent same commandId.
  assert.deepEqual(await runs.dispatch(resolveBody, context(workspaceId)), resolved);

  // Stale second answer (different commandId) is rejected.
  await assert.rejects(
    () =>
      runs.dispatch(
        {
          ...resolveBody,
          commandId: "resolve-op-answer-dup",
          answer: "Different answer must not win",
        },
        context(workspaceId),
      ),
    /stale|already closed/,
  );

  // Continuation plan should run (gen 1) and open plan gate or advance.
  const after = await waitForRunState(
    runs,
    receipt.runId,
    ["waiting_for_operator", "running", "queued"],
    30_000,
  );
  const planAfter = after.snapshot.nodes.find((n) => n.key === "plan");
  assert.ok(planAfter);
  assert.ok(
    planAfter!.generation >= 1,
    `expected plan generation >= 1, got ${planAfter!.generation}`,
  );
  assert.ok(planInvocations >= 2, `expected >=2 plan invocations, got ${planInvocations}`);
  assert.equal(seenOperatorInput[0], false);
  assert.equal(seenOperatorInput[1], true);

  // Old attempt remains suspended (not overwritten to succeeded/failed).
  const stillSuspended = after.snapshot.attempts.find((a) => a.attemptId === suspended!.attemptId);
  assert.ok(stillSuspended);
  assert.equal(stillSuspended!.state, "suspended");

  const opGate = after.snapshot.gates.find((g) => g.gateId === gate!.gateId);
  assert.equal(opGate?.state, "resolved");
  assert.equal(opGate?.decision?.decision, "answer");
});

test("cancel_run while waiting for operator_input withdraws gate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan") return gateRequestedPlan(input);
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-op-cancel", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const waiting = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const gate = waiting.snapshot.gates.find(
    (g) => g.kind === "operator_input" && g.state === "open",
  );
  assert.ok(gate);

  const cancelled = await runs.dispatch(
    {
      type: "cancel_run",
      commandId: "cancel-op-wait",
      runId: receipt.runId,
      expectedRevision: waiting.snapshot.revision,
    },
    context(workspaceId),
  );
  assert.equal(cancelled.accepted, true);

  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.state, "cancelled");
  const withdrawn = snapshot.gates.find((g) => g.gateId === gate!.gateId);
  assert.equal(withdrawn?.state, "withdrawn");

  const wasSuspended = snapshot.attempts.find((a) => a.nodeKey === "plan");
  // Cancel promotes suspended → cancelled for a clean terminal audit trail.
  assert.ok(wasSuspended);
  assert.equal(wasSuspended!.state, "cancelled");

  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "resolve_gate",
          commandId: "resolve-after-cancel",
          runId: receipt.runId,
          expectedRevision: snapshot.revision,
          gateId: gate!.gateId,
          gateKind: "operator_input",
          payloadDigest: gate!.payloadDigest,
          decision: "answer",
          answer: "too late",
        },
        context(workspaceId),
      ),
    /cancel|stale|already closed/i,
  );
});

test("restart does not resume old Pi worker — new attempt after answer", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let livePlanStarts = 0;
  const first = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan") {
        livePlanStarts += 1;
        return gateRequestedPlan(input);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });

  const receipt = await first.dispatch(
    { type: "start_run", commandId: "start-op-restart", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const waiting = await waitForRunState(first, receipt.runId, ["waiting_for_operator"]);
  const gate = waiting.snapshot.gates.find(
    (g) => g.kind === "operator_input" && g.state === "open",
  );
  assert.ok(gate);
  const suspendedId = waiting.snapshot.attempts.find((a) => a.state === "suspended")?.attemptId;
  assert.ok(suspendedId);
  assert.equal(livePlanStarts, 1);
  await first.close();

  // Re-open owner: suspended attempt must NOT be re-executed; only answer unlocks gen+1.
  let secondPlanStarts = 0;
  const reopened = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan") {
        secondPlanStarts += 1;
        assert.ok(
          input.sealedInputs.some((item) => item.role === "operator_input"),
          "post-restart continuation must bind sealed answer",
        );
        assert.notEqual(input.attemptId, suspendedId, "must not resume old attempt id");
        return succeededPlan(input);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => reopened.close());

  // Still waiting — no auto-resume of old worker.
  const still = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(still.state, "waiting_for_operator");
  assert.equal(secondPlanStarts, 0);

  await reopened.dispatch(
    {
      type: "resolve_gate",
      commandId: "resolve-after-restart",
      runId: receipt.runId,
      expectedRevision: still.revision,
      gateId: gate!.gateId,
      gateKind: "operator_input",
      payloadDigest: gate!.payloadDigest,
      decision: "answer",
      answer: "Restart-safe audience answer",
    },
    context(workspaceId),
  );

  await waitForRunState(
    reopened,
    receipt.runId,
    ["waiting_for_operator", "running", "queued"],
    30_000,
  );
  assert.ok(secondPlanStarts >= 1, "new Attempt must start after answer post-restart");
  const snap = (await reopened.read({ runId: receipt.runId })).snapshot;
  const old = snap.attempts.find((a) => a.attemptId === suspendedId);
  assert.equal(old?.state, "suspended");
  assert.ok(snap.attempts.some((a) => a.nodeKey === "plan" && a.nodeGeneration >= 1));
});
