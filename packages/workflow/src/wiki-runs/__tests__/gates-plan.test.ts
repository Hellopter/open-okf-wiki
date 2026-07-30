import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  PLAN_PAYLOAD_DIGEST,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  seedOpenPlanGate,
  seedPlanSpecArtifact,
  succeededProbe,
  waitForRunState,
  waitForTerminal,
} from "./harness.js";

test("ResolveGate plan approve, revise, and deny follow the ADR decision table", async (t) => {
  // approve without Spec fails closed (honest until T3 graph materialization)
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-approve-nospec" , intent: { mode: "generate" } },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-approve-nospec" });
    const reopened = await openWikiRuns({ rootPath: root });
    t.after(() => reopened.close());
    await assert.rejects(
      () =>
        reopened.dispatch(
          {
            type: "resolve_gate",
            commandId: "resolve-approve-nospec",
            runId: receipt.runId,
            gateId,
            gateKind: "plan",
            payloadDigest: PLAN_PAYLOAD_DIGEST,
            decision: "approve",
          },
          context(workspaceId),
        ),
      /sealed Spec artifact/,
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "open");
  }

  // approve with sealed Spec
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-approve" , intent: { mode: "generate" } },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-approve" });
    await seedPlanSpecArtifact(root, receipt.runId);
    const reopened = await openWikiRuns({ rootPath: root });
    const approved = await reopened.dispatch(
      {
        type: "resolve_gate",
        commandId: "resolve-approve",
        runId: receipt.runId,
        gateId,
        gateKind: "plan",
        payloadDigest: PLAN_PAYLOAD_DIGEST,
        decision: "approve",
      },
      context(workspaceId),
    );
    assert.equal(approved.accepted, true);
    assert.deepEqual(
      await reopened.dispatch(
        {
          type: "resolve_gate",
          commandId: "resolve-approve",
          runId: receipt.runId,
          gateId,
          gateKind: "plan",
          payloadDigest: PLAN_PAYLOAD_DIGEST,
          decision: "approve",
        },
        context(workspaceId),
      ),
      approved,
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "resolved");
    assert.equal(snapshot.gates[0]?.decision?.decision, "approve");
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.nodes.find((node) => node.key === "gate.plan")?.state, "succeeded");
    // Definition v1: write.root stays blocked until research.domain.* succeed.
    assert.equal(snapshot.nodes.find((node) => node.key === "write.root")?.state, "blocked");
    assert.ok(
      snapshot.nodes.some((node) => node.kind === "research.leaf" && node.state === "ready"),
    );
    await assert.rejects(
      () =>
        reopened.dispatch(
          {
            type: "resolve_gate",
            commandId: "resolve-approve-stale",
            runId: receipt.runId,
            gateId,
            gateKind: "plan",
            payloadDigest: PLAN_PAYLOAD_DIGEST,
            decision: "deny",
          },
          context(workspaceId),
        ),
      /stale|already closed/,
    );
    await reopened.close();
  }

  // revise
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-revise" , intent: { mode: "generate" } },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-revise" });
    const reopened = await openWikiRuns({ rootPath: root });
    await reopened.dispatch(
      {
        type: "resolve_gate",
        commandId: "resolve-revise",
        runId: receipt.runId,
        gateId,
        gateKind: "plan",
        payloadDigest: PLAN_PAYLOAD_DIGEST,
        decision: "revise",
        feedback: "Narrow the scope to the runtime seam.",
      },
      context(workspaceId),
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "resolved");
    assert.equal(snapshot.gates[0]?.decision?.decision, "revise");
    const plan = snapshot.nodes.find((node) => node.key === "plan");
    assert.equal(plan?.generation, 1);
    assert.equal(plan?.state, "ready");
    assert.equal(snapshot.state, "queued");
    await reopened.close();
  }

  // deny
  {
    const { root, workspaceId } = await makeWorkspace();
    t.after(() => removeWorkspace(root));
    const runs = await openWikiRuns({ rootPath: root });
    const receipt = await runs.dispatch(
      { type: "start_run", commandId: "start-gate-deny" , intent: { mode: "generate" } },
      context(workspaceId),
    );
    await waitForTerminal(runs, receipt.runId);
    await runs.close();
    const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-deny" });
    const reopened = await openWikiRuns({ rootPath: root });
    await reopened.dispatch(
      {
        type: "resolve_gate",
        commandId: "resolve-deny",
        runId: receipt.runId,
        gateId,
        gateKind: "plan",
        payloadDigest: PLAN_PAYLOAD_DIGEST,
        decision: "deny",
      },
      context(workspaceId),
    );
    const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
    assert.equal(snapshot.gates[0]?.state, "resolved");
    assert.equal(snapshot.gates[0]?.decision?.decision, "deny");
    assert.equal(snapshot.state, "cancelled");
    assert.equal(snapshot.cancelRequested, true);
    await reopened.close();
  }
});

test("scheduler plan claim binds freeze sealed outputs as attempt_inputs", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let releasePlan: (() => void) | undefined;
  const planBlocked = new Promise<void>((resolve) => {
    releasePlan = resolve;
  });
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key !== "plan") return succeededProbe(input.workDir);
      await Promise.race([
        planBlocked,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (signal.aborted) {
        return { type: "failed", error: "cancelled", failureClass: "cancelled" };
      }
      return succeededProbe(input.workDir);
    },
  });
  t.after(async () => {
    releasePlan?.();
    await runs.close();
  });

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-plan-inputs" , intent: { mode: "generate" } },
    context(workspaceId),
  );

  let claimAttemptId: string | undefined;
  let freezeOutputs: Array<{ role: string; artifact_id: string }> | undefined;
  for (let count = 0; count < 200; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const plan = snapshot.nodes.find((node) => node.key === "plan");
    const planAttempt = snapshot.attempts.find(
      (attempt) => attempt.nodeKey === "plan" && attempt.state === "running",
    );
    if (plan?.state === "running" && planAttempt) {
      claimAttemptId = planAttempt.attemptId;
      freezeOutputs = snapshot.nodes
        .find((node) => node.key === "freeze")
        ?.outputs.map((output) => ({
          role: output.role,
          artifact_id: output.artifact.artifactId,
        }))
        .sort((a, b) => a.role.localeCompare(b.role));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(claimAttemptId, "scheduler should claim plan after freeze");
  assert.ok(freezeOutputs && freezeOutputs.length >= 2);

  // Inspect attempt_inputs while the owner still holds the lock via SQL through a second
  // connection is blocked by EXCLUSIVE; release the hanging plan then re-read after close.
  releasePlan?.();
  for (let count = 0; count < 200; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const planAttempt = snapshot.attempts.find((attempt) => attempt.attemptId === claimAttemptId);
    if (planAttempt && planAttempt.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const bound = db
    .prepare(`SELECT role, artifact_id FROM attempt_inputs WHERE attempt_id = ? ORDER BY role`)
    .all(claimAttemptId) as Array<{ role: string; artifact_id: string }>;
  const freezeAttemptInputs = db
    .prepare(
      `SELECT COUNT(*) AS count FROM attempt_inputs
       WHERE attempt_id = (
         SELECT attempt_id FROM attempts
         WHERE run_id = ? AND node_key = 'freeze' ORDER BY started_at LIMIT 1
       )`,
    )
    .get(receipt.runId) as { count: number };
  db.close();

  // Plan binds freeze pins (sources + skill + frozen_run_manifest), not attempt_output noise.
  const expected = (freezeOutputs ?? [])
    .filter(
      (row) =>
        row.role === "sources" || row.role === "skill" || row.role === "frozen_run_manifest",
    )
    .sort((a, b) => a.role.localeCompare(b.role));
  assert.deepEqual(
    bound.map((row) => ({ role: row.role, artifact_id: row.artifact_id })),
    expected,
  );
  // Freeze has no upstream sealed outputs.
  assert.equal(freezeAttemptInputs.count, 0);
});

test("StartRun freezes, plans via executor, opens gate.plan, and ResolveGate approve materializes Definition v1 graph", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-plan-gate" , intent: { mode: "generate" } },
    context(workspaceId),
  );

  const atPlanGate = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const openGate = atPlanGate.snapshot.gates.find(
    (item) => item.kind === "plan" && item.state === "open",
  );
  assert.ok(openGate, "plan gate should open after Spec seal");
  assert.equal(atPlanGate.snapshot.nodes.find((node) => node.key === "plan")?.state, "succeeded");
  assert.equal(
    atPlanGate.snapshot.nodes.find((node) => node.key === "gate.plan")?.state,
    "waiting",
  );

  const approved = await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-plan-gate",
      runId: receipt.runId,
      gateId: openGate.gateId,
      gateKind: "plan",
      payloadDigest: openGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  assert.equal(approved.accepted, true);

  // Graph materialization is synchronous in ResolveGate; read immediately.
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(after.gates.find((g) => g.kind === "plan")?.state, "resolved");
  assert.equal(after.nodes.find((node) => node.key === "gate.plan")?.state, "succeeded");
  const leaves = after.nodes.filter((node) => node.kind === "research.leaf");
  const domains = after.nodes.filter((node) => node.kind === "research.domain");
  assert.ok(leaves.length >= 1, "approve should materialize research.leaf nodes");
  assert.ok(domains.length >= 1, "approve should materialize research.domain nodes");
  assert.ok(after.nodes.some((node) => node.key === "write.root"));
  assert.ok(after.nodes.some((node) => node.key === "validate.pre"));
  assert.ok(after.nodes.some((node) => node.key === "review.reduce"));
  assert.ok(after.nodes.some((node) => node.key === "prepare.publication"));
  assert.ok(after.nodes.some((node) => node.key === "gate.publication"));
  assert.ok(after.nodes.some((node) => node.key === "publish"));
  // Stop scheduler before teardown so attempt dirs are not mid-write.
  await runs.close();
});
