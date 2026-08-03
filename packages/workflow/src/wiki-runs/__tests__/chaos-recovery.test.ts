/**
 * Chaos / crash-recovery drills for durable WikiRuns.
 *
 * Complements (does not duplicate):
 * - freeze-recovery.test.ts — freeze interrupt, kill owner, tampered seals
 * - publish-effects.test.ts — applying→applied/unknown reconcile, cancel vs applying
 *
 * Locks production-agent best practice: durable runs survive process death mid-attempt
 * and mid-apply without double-commit or cancelled applying effects.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  reachPublicationGate,
  removeWorkspace,
  succeededPlan,
  succeededProbe,
  waitForRunState,
} from "./harness.js";

test("close mid plan Pi attempt interrupts; RetryFailedNode reclaims the failed node", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let started!: () => void;
  const startedPlan = new Promise<void>((resolve) => {
    started = resolve;
  });
  let planCalls = 0;
  const owner = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "freeze") return succeededProbe(input.workDir);
      if (input.node.key === "plan") {
        planCalls += 1;
        if (planCalls === 1) {
          started();
          // Hang until owner close aborts the Attempt (process death / clean stop).
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          // Late "success" after abort must not CAS-commit (closed / !isCurrent).
          return succeededPlan(input);
        }
        return succeededPlan(input);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });

  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "chaos-close-mid-plan", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await startedPlan;
  await owner.close();

  const reopened = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => reopened.close());

  const interrupted = await reopened.read({ runId: receipt.runId });
  // interruptRunningAttempts: attempt → interrupted, node → failed, run → failed.
  // Node is not auto-ready; operator RetryFailedNode re-queues (re-claimable).
  assert.equal(interrupted.snapshot.state, "failed");
  assert.equal(interrupted.snapshot.nodes.find((n) => n.key === "freeze")?.state, "succeeded");
  const plan = interrupted.snapshot.nodes.find((n) => n.key === "plan");
  assert.equal(plan?.state, "failed");
  assert.equal(plan?.currentAttemptId, null);
  assert.ok(plan?.lastAttemptId);
  const firstAttempt = interrupted.snapshot.attempts.find(
    (a) => a.attemptId === plan?.lastAttemptId,
  );
  assert.equal(firstAttempt?.state, "interrupted");
  assert.equal(firstAttempt?.error, "owner stopped");
  assert.deepEqual(plan?.outputs ?? [], []);
  assert.ok(interrupted.events.some((e) => e.type === "attempt.interrupted"));

  await reopened.dispatch(
    {
      type: "retry_failed_node",
      commandId: "chaos-retry-plan",
      runId: receipt.runId,
      expectedRevision: interrupted.snapshot.revision,
      nodeKey: "plan",
      generation: 0,
      attemptId: plan!.lastAttemptId!,
    },
    context(workspaceId),
  );

  const atGate = await waitForRunState(reopened, receipt.runId, ["waiting_for_operator"]);
  assert.equal(atGate.snapshot.nodes.find((n) => n.key === "plan")?.state, "succeeded");
  assert.ok(atGate.snapshot.gates.some((g) => g.kind === "plan" && g.state === "open"));
  const planAttempts = atGate.snapshot.attempts.filter((a) => a.nodeKey === "plan");
  assert.ok(planAttempts.length >= 2);
  assert.equal(planAttempts.filter((a) => a.state === "interrupted").length, 1);
  assert.equal(planAttempts.filter((a) => a.state === "succeeded").length, 1);
  // No double commit from the interrupted generation.
  assert.equal(
    planAttempts.filter((a) => a.state === "succeeded").length,
    1,
    "exactly one succeeded plan attempt after reclaim",
  );
});

test("recover() after process reopen with a running plan attempt row interrupts without double commit", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  // Drive freeze→plan success, then model a kill -9 window: durable rows left running
  // with no prepared CAS group (mid-attempt, pre-seal).
  const owner = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "chaos-dirty-running-plan", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const atGate = await waitForRunState(owner, receipt.runId, ["waiting_for_operator"]);
  const planAttempt = atGate.snapshot.attempts.find(
    (a) => a.nodeKey === "plan" && a.state === "succeeded",
  );
  assert.ok(planAttempt);
  const planOutputsBefore = atGate.snapshot.nodes.find((n) => n.key === "plan")?.outputs ?? [];
  assert.ok(planOutputsBefore.length >= 1, "plan must have sealed outputs before crash model");
  await owner.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  // Drop plan lineage so a late recover commit cannot re-attach outputs under the
  // interrupted attempt (assert no double commit after interrupt).
  db.prepare(
    "DELETE FROM attempt_inputs WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE run_id = ? AND node_key = 'plan')",
  ).run(receipt.runId);
  db.prepare("DELETE FROM node_outputs WHERE run_id = ? AND node_key = 'plan'").run(receipt.runId);
  db.prepare("DELETE FROM artifacts WHERE run_id = ? AND producer_attempt_id = ?").run(
    receipt.runId,
    planAttempt.attemptId,
  );
  db.prepare("DELETE FROM gates WHERE run_id = ? AND kind = 'plan'").run(receipt.runId);
  db.prepare("DELETE FROM artifact_preparations WHERE attempt_id = ?").run(planAttempt.attemptId);
  db.prepare(
    "UPDATE attempts SET state = 'running', ended_at = NULL, error = NULL WHERE attempt_id = ?",
  ).run(planAttempt.attemptId);
  db.prepare(
    `UPDATE nodes SET state = 'running', current_attempt_id = ?, last_attempt_id = ?
     WHERE run_id = ? AND node_key = 'plan' AND generation = 0`,
  ).run(planAttempt.attemptId, planAttempt.attemptId, receipt.runId);
  // gate.plan may still be waiting from the prior success path — park it blocked.
  db.prepare(
    `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
     WHERE run_id = ? AND node_key = 'gate.plan'`,
  ).run(receipt.runId);
  db.prepare("UPDATE runs SET state = 'running', cancel_requested = 0 WHERE run_id = ?").run(
    receipt.runId,
  );
  db.close();

  // openWikiRuns → recover(): prepared CAS (none) → applying reconcile → interrupt running.
  const recovered = await openWikiRuns({ rootPath: root });
  t.after(() => recovered.close());
  const result = await recovered.read({ runId: receipt.runId });
  const snap = result.snapshot;

  assert.equal(snap.state, "failed");
  const plan = snap.nodes.find((n) => n.key === "plan");
  assert.equal(plan?.state, "failed");
  assert.equal(plan?.currentAttemptId, null);
  assert.equal(plan?.lastAttemptId, planAttempt.attemptId);
  const attempt = snap.attempts.find((a) => a.attemptId === planAttempt.attemptId);
  assert.equal(attempt?.state, "interrupted");
  assert.equal(attempt?.error, "owner stopped");
  // No double commit: interrupted running row without prepared artifacts leaves no outputs.
  assert.deepEqual(plan?.outputs ?? [], []);
  assert.ok(result.events.some((e) => e.type === "attempt.interrupted"));
  // Post-interrupt: no succeeded attempt row for the crashed attempt id.
  assert.notEqual(attempt?.state, "succeeded");

  // Second reopen is idempotent: still failed/interrupted, no extra commit.
  await recovered.close();
  const again = await openWikiRuns({ rootPath: root });
  t.after(() => again.close());
  const againResult = await again.read({ runId: receipt.runId });
  const againSnap = againResult.snapshot;
  assert.equal(againSnap.state, "failed");
  assert.equal(againSnap.nodes.find((n) => n.key === "plan")?.state, "failed");
  assert.equal(
    againSnap.attempts.find((a) => a.attemptId === planAttempt.attemptId)?.state,
    "interrupted",
  );
  assert.deepEqual(againSnap.nodes.find((n) => n.key === "plan")?.outputs ?? [], []);
  const interruptEvents = againResult.events.filter((e) => e.type === "attempt.interrupted");
  // First recover emitted interrupt; second recover finds no running attempts.
  assert.equal(interruptEvents.length, 1);
});

/**
 * Publication applying crash / reconcile:
 * Full coverage lives in publish-effects.test.ts
 * ("T5 reconcile applying→applied when live already matches sealed candidate",
 *  "T5 CancelRun before applying…", "recovery marks applying effects unknown…" in freeze-recovery).
 * Here: double recover is idempotent — applying never becomes cancelled, second open is a no-op.
 */
test("double recover on applying publication effect is idempotent", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "chaos-double-recover",
  );
  const publicationRevision = (await runs.read({ runId })).snapshot.revision;

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "chaos-double-recover-approve",
      runId,
      expectedRevision: publicationRevision,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  assert.equal(
    published.snapshot.effects.find((e) => e.effectKey === effect.effectKey)?.state,
    "applied",
  );
  await runs.close();

  // Crash window: applied → applying while live already holds the sealed candidate.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "UPDATE effects SET state = 'applying', observed_outcome = NULL WHERE effect_key = ?",
  ).run(effect.effectKey);
  db.prepare("UPDATE runs SET state = 'running', cancel_requested = 0 WHERE run_id = ?").run(runId);
  db.close();

  const first = await openWikiRuns({ rootPath: root });
  const firstResult = await first.read({ runId });
  const firstSnap = firstResult.snapshot;
  const firstEffect = firstSnap.effects.find((e) => e.effectKey === effect.effectKey);
  assert.ok(firstEffect);
  assert.notEqual(firstEffect.state, "cancelled");
  assert.equal(firstEffect.state, "applied");
  assert.equal(firstSnap.state, "published");
  const appliedEventsFirst = firstResult.events.filter((e) => e.type === "effect.applied").length;
  await first.close();

  // Second recover: no applying rows remain → no state churn, still applied/published.
  const second = await openWikiRuns({ rootPath: root });
  t.after(() => second.close());
  const secondResult = await second.read({ runId });
  const secondSnap = secondResult.snapshot;
  const secondEffect = secondSnap.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(secondEffect?.state, "applied");
  assert.equal(secondSnap.state, "published");
  assert.notEqual(secondEffect?.state, "cancelled");
  const appliedEventsSecond = secondResult.events.filter((e) => e.type === "effect.applied").length;
  assert.equal(
    appliedEventsSecond,
    appliedEventsFirst,
    "second recover must not re-emit effect.applied",
  );
});

test("close mid research.leaf Pi attempt fails the node; run is not auto-reclaimed", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let started!: () => void;
  const startedLeaf = new Promise<void>((resolve) => {
    started = resolve;
  });
  const owner = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "research.leaf") {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        // Late success after abort must not commit.
        const leafReceipt = path.join(input.workDir, "analysis", `${input.node.key}.json`);
        await mkdir(path.dirname(leafReceipt), { recursive: true });
        await writeFile(leafReceipt, `${JSON.stringify({ ok: true })}\n`, "utf8");
        return {
          type: "succeeded",
          unsealedArtifacts: [
            { kind: "receipt", role: "research", sourcePath: leafReceipt, directory: false },
          ],
          summary: "late leaf",
        } satisfies PiAttemptOutcome;
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });

  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "chaos-close-mid-leaf", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const atPlan = await waitForRunState(owner, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate);
  await owner.dispatch(
    {
      type: "resolve_gate",
      commandId: "chaos-close-mid-leaf-approve",
      runId: receipt.runId,
      expectedRevision: atPlan.snapshot.revision,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  await startedLeaf;
  await owner.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snap.state, "failed");
  const interruptedLeaves = snap.attempts.filter(
    (a) => a.nodeKey.startsWith("research.leaf") && a.state === "interrupted",
  );
  assert.ok(interruptedLeaves.length >= 1, "at least one leaf attempt interrupted on close");
  const leafNodes = snap.nodes.filter((n) => n.key.startsWith("research.leaf"));
  assert.ok(
    leafNodes.some((n) => n.state === "failed"),
    "interrupted leaf node must be failed (not auto ready)",
  );
  assert.ok(
    leafNodes.every((n) => n.state !== "ready" && n.state !== "running"),
    "no leaf remains claimable without RetryFailedNode after owner stop",
  );
  for (const leaf of leafNodes.filter((n) => n.state === "failed")) {
    assert.deepEqual(leaf.outputs, []);
  }
});
