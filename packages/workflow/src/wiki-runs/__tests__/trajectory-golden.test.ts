/**
 * Trajectory goldens — process-level evaluation for WikiRuns.
 *
 * These are Anthropic-style *process* evals: they assert the durable control-plane
 * trajectory (event type order, key node milestones, attempt claim sequence, terminal
 * state), not pure unit functions. They reuse the existing fixture PiAttemptExecutor
 * and harness helpers so they stay fast, deterministic, and do not invent a second
 * control plane.
 *
 * Unit tests cover edge cases; these goldens lock the happy-path and cancel shapes
 * an operator (or eval harness) should observe end-to-end.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WikiRunEvent, WikiRunSnapshot } from "@okf-wiki/contract";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForRunState,
} from "./harness.js";

/** Event-type sequence from the durable event log (process trajectory spine). */
function eventTypes(events: readonly WikiRunEvent[]): string[] {
  return events.map((event) => event.type);
}

/**
 * Assert `expected` appears in order inside `actual` (not necessarily contiguous).
 * Process goldens care about milestone order, not every intermediate scheduler tick.
 */
function assertSubsequence(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  let from = 0;
  for (const item of expected) {
    const at = actual.indexOf(item, from);
    assert.ok(
      at >= 0,
      `${label}: expected milestone "${item}" after index ${from} in [${actual.join(", ")}]`,
    );
    from = at + 1;
  }
}

/** Set of node keys currently in `succeeded` (snapshot node list is not process-ordered). */
function succeededNodeKeySet(snapshot: WikiRunSnapshot): Set<string> {
  return new Set(
    snapshot.nodes.filter((node) => node.state === "succeeded").map((node) => node.key),
  );
}

/** Assert every key is present among succeeded nodes (membership, not array order). */
function assertSucceededMilestones(
  snapshot: WikiRunSnapshot,
  keys: readonly string[],
  label: string,
): void {
  const succeeded = succeededNodeKeySet(snapshot);
  for (const key of keys) {
    assert.ok(succeeded.has(key), `${label}: expected succeeded node "${key}"`);
  }
}

/**
 * Attempt claim sequence ordered by startedAt (process order).
 * Snapshot `attempts` may not be insertion-ordered across reopen; sort for goldens.
 */
function attemptTrajectory(snapshot: WikiRunSnapshot): string[] {
  return [...snapshot.attempts]
    .sort((a, b) => {
      const byStart = a.startedAt.localeCompare(b.startedAt);
      if (byStart !== 0) return byStart;
      return a.attemptId.localeCompare(b.attemptId);
    })
    .map((attempt) => `${attempt.nodeKey}:${attempt.state}`);
}

/** First attempt for a node key, if any (earliest startedAt). */
function firstAttempt(snapshot: WikiRunSnapshot, nodeKey: string) {
  return [...snapshot.attempts]
    .filter((attempt) => attempt.nodeKey === nodeKey)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
}

test("trajectory golden: StartRun → freeze → plan → gate.plan (waiting_for_operator)", async (t) => {
  // Process shape through the first HITL gate — the minimal durable spine operators see.
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "traj-plan-gate-start", intent: { mode: "generate" } },
    context(workspaceId),
  );

  const atGate = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const { snapshot, events } = atGate;

  // Terminal / gate state for this path.
  assert.equal(snapshot.state, "waiting_for_operator");
  assert.equal(snapshot.cancelRequested, false);

  // Node milestones: freeze and plan succeeded; gate.plan is waiting.
  assert.equal(snapshot.nodes.find((n) => n.key === "freeze")?.state, "succeeded");
  assert.equal(snapshot.nodes.find((n) => n.key === "plan")?.state, "succeeded");
  assert.equal(snapshot.nodes.find((n) => n.key === "gate.plan")?.state, "waiting");
  assert.ok(
    snapshot.gates.some((g) => g.kind === "plan" && g.state === "open"),
    "open plan gate is the HITL milestone",
  );

  // Succeeded milestones: freeze + plan only so far (no post-approve graph).
  assertSucceededMilestones(snapshot, ["freeze", "plan"], "plan-gate nodes");
  assert.ok(
    !succeededNodeKeySet(snapshot).has("write.root"),
    "pre-approve graph must not run write.root",
  );

  // Attempt claim order: freeze claimed/succeeded before plan.
  const attempts = attemptTrajectory(snapshot);
  assertSubsequence(attempts, ["freeze:succeeded", "plan:succeeded"], "attempt trajectory");
  const freezeAttempt = firstAttempt(snapshot, "freeze");
  const planAttempt = firstAttempt(snapshot, "plan");
  assert.ok(freezeAttempt && planAttempt);
  assert.ok(
    (freezeAttempt.endedAt ?? freezeAttempt.startedAt) <= planAttempt.startedAt,
    "freeze attempt ends before plan starts (process order)",
  );

  // Event trajectory spine observed on the durable log (freeze pins mid-attempt).
  assertSubsequence(
    eventTypes(events),
    [
      "run.started",
      "attempt.started", // freeze claim
      "inputs.pinned",
      "attempt.succeeded", // freeze
      "node.ready", // plan becomes ready
      "attempt.started", // plan claim
      "attempt.succeeded", // plan
      "gate.opened", // gate.plan
    ],
    "event trajectory to plan gate",
  );
});

test("trajectory golden: approve plan → full graph → publication gate → published", async (t) => {
  // Full happy-path process shape through publication (fixture executor, no LLM).
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "traj-publish-start", intent: { mode: "generate" } },
    context(workspaceId),
  );

  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate, "plan gate opens before graph materialization");

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "traj-publish-approve-plan",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open");
  assert.ok(pubGate, "publication gate is the second HITL milestone");

  // Key post-plan milestones present before publication gate (membership + attempt order).
  assertSucceededMilestones(
    atPub.snapshot,
    ["freeze", "plan", "gate.plan", "write.root", "prepare.publication"],
    "mid-run succeeded milestones",
  );
  assertSubsequence(
    attemptTrajectory(atPub.snapshot),
    ["freeze:succeeded", "plan:succeeded", "write.root:succeeded"],
    "mid-run attempt trajectory",
  );
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "gate.publication")?.state, "waiting");
  assert.ok(
    atPub.snapshot.effects.some((e) => e.state === "prepared" || e.state === "candidate_ready"),
    "prepared effect bound before publication gate",
  );

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "traj-publish-approve-pub",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  const published = await waitForRunState(runs, receipt.runId, ["published"], 30_000);
  const { snapshot, events } = published;

  assert.equal(snapshot.state, "published");
  assert.equal(snapshot.nodes.find((n) => n.key === "publish")?.state, "succeeded");
  assert.ok(snapshot.effects.some((e) => e.state === "applied"));

  // Final process spine via attempt claim order + node membership.
  assertSucceededMilestones(
    snapshot,
    ["freeze", "plan", "write.root", "prepare.publication", "publish"],
    "published succeeded milestones",
  );
  assertSubsequence(
    attemptTrajectory(snapshot),
    ["freeze:succeeded", "plan:succeeded", "write.root:succeeded"],
    "published attempt trajectory (prefix)",
  );

  // Event spine across both gates and effect apply.
  // prepare.publication emits effect.prepared before gate.publication opens.
  assertSubsequence(
    eventTypes(events),
    [
      "run.started",
      "inputs.pinned",
      "gate.opened", // plan
      "gate.resolved",
      "effect.prepared",
      "gate.opened", // publication
      "gate.resolved",
      "effect.applied",
      "run.published",
    ],
    "event trajectory to published",
  );
});

test("trajectory golden: cancel mid-flight → cancelled, no further claims", async (t) => {
  // Cancel process shape: abort in-flight plan attempt, land cancelled, no late commit.
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let started!: () => void;
  const startedAttempt = new Promise<void>((resolve) => {
    started = resolve;
  });
  let postCancelClaims = 0;
  let cancelSeen = false;

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      assert.equal(input.node.key, "plan");
      if (cancelSeen) {
        postCancelClaims += 1;
        return succeededPlan(input);
      }
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      // Late success must not commit after cancel (control plane owns terminal state).
      return succeededPlan(input);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "traj-cancel-start", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await startedAttempt;

  await runs.dispatch(
    {
      type: "cancel_run",
      commandId: "traj-cancel-1",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
    },
    context(workspaceId),
  );
  cancelSeen = true;

  const terminal = await waitForRunState(runs, receipt.runId, ["cancelled"]);
  const { snapshot, events } = terminal;

  assert.equal(snapshot.state, "cancelled");
  assert.equal(snapshot.cancelRequested, true);
  assert.equal(postCancelClaims, 0, "no new Pi claims after cancel accepted");

  // In-flight plan attempt ends cancelled (not succeeded).
  const planAttempt = firstAttempt(snapshot, "plan");
  assert.ok(planAttempt, "plan was claimed before cancel");
  assert.equal(planAttempt.state, "cancelled");
  assert.equal(snapshot.nodes.find((n) => n.key === "plan")?.state, "cancelled");

  // Freeze stays mechanical; no post-cancel Pi work can be claimed.
  assert.equal(
    snapshot.attempts.filter((a) => a.nodeKey !== "freeze" && a.nodeKey !== "plan").length,
    0,
    "no post-plan Pi node may be claimed after cancel",
  );
  assert.ok(!succeededNodeKeySet(snapshot).has("plan"), "plan must not succeed after cancel");

  // Cancel event spine.
  assertSubsequence(
    eventTypes(events),
    ["run.started", "run.cancel_requested", "run.cancelled"],
    "cancel event trajectory",
  );

  // After terminal cancel, no attempt is left running/ready for claim.
  assert.ok(
    snapshot.attempts.every((a) => a.state !== "running"),
    "no running attempts after cancel terminal",
  );
  assert.ok(
    snapshot.nodes.every((n) => n.state !== "running" && n.state !== "ready"),
    "no ready/running nodes left to claim after cancel",
  );
});
