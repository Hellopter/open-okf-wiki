import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  reachPublicationGate,
  removeWorkspace,
  waitForRunState,
} from "./harness.js";

test("fixture e2e StartRun → plan gate → full graph → publication gate → published", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-e2e-full" , intent: { mode: "generate" } },
    context(workspaceId),
  );

  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate);

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-e2e-plan",
      runId: receipt.runId,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open");
  assert.ok(pubGate, "publication gate should open after prepare.publication");
  assert.equal(
    atPub.snapshot.nodes.find((n) => n.key === "prepare.publication")?.state,
    "succeeded",
  );
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "write.root")?.state, "succeeded");
  assert.ok(
    atPub.snapshot.effects.some((e) => e.state === "prepared" || e.state === "candidate_ready"),
  );

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-e2e-pub",
      runId: receipt.runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  const published = await waitForRunState(runs, receipt.runId, ["published"], 30_000);
  assert.equal(published.snapshot.state, "published");
  assert.equal(published.snapshot.nodes.find((n) => n.key === "publish")?.state, "succeeded");
  assert.ok(published.snapshot.effects.some((e) => e.state === "applied"));
});

test("fixture e2e publication deny yields completed_unpublished", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-e2e-deny" , intent: { mode: "generate" } },
    context(workspaceId),
  );
  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open")!;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "approve-deny-plan",
      runId: receipt.runId,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open")!;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "deny-e2e-pub",
      runId: receipt.runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "deny",
    },
    context(workspaceId),
  );
  const done = await waitForRunState(runs, receipt.runId, ["completed_unpublished"]);
  assert.equal(done.snapshot.state, "completed_unpublished");
});

test("T5 prepare.publication captures baseline and binds effect+gate payload", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(root, workspaceId, "t5-bind");
  t.after(() => runs.close());

  assert.equal(effect.state, "prepared");
  assert.equal(effect.publicationNodeKey, "prepare.publication");
  assert.match(effect.effectKey, new RegExp(`^publish:${runId}:\\d+:[a-f0-9]{64}$`));
  // First publish: empty baseline digest (canonical empty tree), not a placeholder of convenience.
  assert.equal(effect.expectedLiveDigest.length, 64);
  assert.equal(effect.candidateDigest.length, 64);
  assert.equal(effect.requestDigest, pubGate.payloadDigest);
  assert.equal(pubGate.state, "open");
});

test("T5 ResolveGate approve advances only the bound prepared effect to candidate_ready", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-approve",
  );
  t.after(() => runs.close());

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-approve-pub",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  // May race through publish; candidate_ready or applied both prove the transition fired.
  for (let i = 0; i < 200; i += 1) {
    const snap = (await runs.read({ runId })).snapshot;
    const e = snap.effects.find((row) => row.effectKey === effect.effectKey);
    if (e && (e.state === "candidate_ready" || e.state === "applying" || e.state === "applied")) {
      assert.ok(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const final = (await runs.read({ runId })).snapshot.effects.find(
    (row) => row.effectKey === effect.effectKey,
  );
  assert.fail(`effect never left prepared: ${final?.state}`);
});

test("T5 PublicationConflict when live baseline changes before apply", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-conflict",
  );
  t.after(() => runs.close());

  // Mutate live publication so baseline no longer matches the sealed expectation.
  const publicationPath = path.join(root, "wiki");
  await mkdir(publicationPath, { recursive: true });
  await writeFile(
    path.join(publicationPath, "intruder.md"),
    "---\ntype: Concept\ntitle: Intruder\n---\n\n# Intruder\n\nExternal change.\n",
    "utf8",
  );

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-approve-conflict",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );

  for (let i = 0; i < 300; i += 1) {
    const snap = (await runs.read({ runId })).snapshot;
    const e = snap.effects.find((row) => row.effectKey === effect.effectKey);
    if (e?.state === "conflict") {
      assert.equal(e.expectedLiveDigest, effect.expectedLiveDigest);
      // Live must not have been overwritten by the stale candidate.
      const body = await readFile(path.join(publicationPath, "intruder.md"), "utf8");
      assert.match(body, /Intruder/);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const last = (await runs.read({ runId })).snapshot;
  assert.fail(
    `expected conflict effect, got ${last.effects.map((e) => e.state).join(",")} run=${last.state}`,
  );
});

test("T5 CancelRun before applying cancels prepared effect; applying is never cancelled", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, effect } = await reachPublicationGate(root, workspaceId, "t5-cancel-pre");
  t.after(() => runs.close());
  assert.equal(effect.state, "prepared");

  await runs.dispatch(
    { type: "cancel_run", commandId: "t5-cancel-pre-apply", runId },
    context(workspaceId),
  );
  const cancelled = await waitForRunState(runs, runId, ["cancelled"]);
  const pre = cancelled.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(pre?.state, "cancelled");

  // Separate path: applying + later cancel_requested must reconcile, not cancel.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const digest = "a".repeat(64);
  const applyingKey = `publish:${runId}:99:${digest}`;
  db.prepare(
    `INSERT INTO effects (
      effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
      request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
    ) VALUES (?, ?, 'prepare.publication', 99, 'gate-applying', 'applying', ?, ?, 'missing-candidate', ?, NULL)`,
  ).run(applyingKey, runId, digest, digest, digest);
  db.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId })).snapshot;
  const applying = snap.effects.find((e) => e.effectKey === applyingKey);
  assert.ok(applying);
  assert.notEqual(applying.state, "cancelled");
  assert.ok(["unknown", "failed", "applied"].includes(applying.state));
});

test("T5 reconcile applying→applied when live already matches sealed candidate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-reconcile",
  );
  // Approve + publish to produce a real sealed candidate on disk, then force applying and recover.
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-reconcile-approve",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  const applied = published.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(applied?.state, "applied");
  await runs.close();

  // Simulate crash window: flip applied → applying while live already holds candidate bytes.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare(
    "UPDATE effects SET state = 'applying', observed_outcome = NULL WHERE effect_key = ?",
  ).run(effect.effectKey);
  db.prepare("UPDATE runs SET state = 'running', cancel_requested = 0 WHERE run_id = ?").run(runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId })).snapshot;
  const reconciled = snap.effects.find((e) => e.effectKey === effect.effectKey);
  assert.ok(reconciled);
  // applying must never become cancelled. When live already holds the sealed
  // candidate, reconcile must complete as applied (ADR 0035).
  assert.notEqual(reconciled.state, "cancelled");
  assert.equal(
    reconciled.state,
    "applied",
    `expected applied after live/candidate match, got ${reconciled.state}`,
  );
  assert.equal(snap.state, "published");
});

test("T5 CancelRun after candidate_ready (pre-apply) cancels effect; post-apply cancel does not", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, effect } = await reachPublicationGate(root, workspaceId, "t5-cancel-ready");
  assert.equal(effect.state, "prepared");
  // Close before approve so the scheduler cannot race into apply.
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  // Simulate ResolveGate(approve) CAS without starting the publish executor.
  db.prepare(
    "UPDATE effects SET state = 'candidate_ready' WHERE effect_key = ? AND state = 'prepared'",
  ).run(effect.effectKey);
  const gateRow = db
    .prepare(
      "SELECT gate_id, payload_digest FROM gates WHERE run_id = ? AND kind = 'publication' AND state = 'open'",
    )
    .get(runId) as { gate_id: string; payload_digest: string };
  db.prepare("UPDATE gates SET state = 'resolved', decision_json = ? WHERE gate_id = ?").run(
    JSON.stringify({
      commandId: "t5-cancel-ready-sim-approve",
      decision: "approve",
      payloadDigest: gateRow.payload_digest,
      decidedAt: new Date().toISOString(),
    }),
    gateRow.gate_id,
  );
  db.prepare("UPDATE runs SET state = 'running', cancel_requested = 0 WHERE run_id = ?").run(runId);
  // Keep publish blocked so CancelRun wins over apply.
  db.prepare(
    `UPDATE nodes SET state = 'blocked', current_attempt_id = NULL
     WHERE run_id = ? AND node_key = 'publish'`,
  ).run(runId);
  db.close();

  const mid = await openWikiRuns({ rootPath: root });
  t.after(() => mid.close());
  const atReady = (await mid.read({ runId })).snapshot.effects.find(
    (e) => e.effectKey === effect.effectKey,
  );
  assert.equal(atReady?.state, "candidate_ready");

  await mid.dispatch(
    { type: "cancel_run", commandId: "t5-cancel-after-ready", runId },
    context(workspaceId),
  );
  const cancelled = await waitForRunState(mid, runId, ["cancelled"], 10_000);
  const preApply = cancelled.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(preApply?.state, "cancelled");
  await mid.close();

  // Post-apply: applying + cancel_requested must reconcile, never cancelled.
  const db2 = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db2.exec("PRAGMA foreign_keys=ON");
  const digest = "b".repeat(64);
  const applyingKey = `publish:${runId}:88:${digest}`;
  db2
    .prepare(
      `INSERT INTO effects (
        effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
        request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
      ) VALUES (?, ?, 'prepare.publication', 88, 'gate-post-apply', 'applying', ?, ?, 'missing', ?, NULL)`,
    )
    .run(applyingKey, runId, digest, digest, digest);
  db2.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(runId);
  db2.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snap = (await reopened.read({ runId })).snapshot;
  const applying = snap.effects.find((e) => e.effectKey === applyingKey);
  assert.ok(applying);
  assert.notEqual(applying.state, "cancelled");
  assert.ok(["unknown", "failed", "applied"].includes(applying.state));
});

test("T5 happy path: approval does not rewrite candidate bytes (content-only identity preserved)", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(
    root,
    workspaceId,
    "t5-bytes",
  );
  t.after(() => runs.close());

  const candidateDigestAtGate = effect.candidateDigest;
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-bytes-approve",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  const finalEffect = published.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(finalEffect?.state, "applied");
  assert.equal(finalEffect?.candidateDigest, candidateDigestAtGate);

  const { digestPublicationTree, digestPublicationTreeContentOnly } = await import(
    "@okf-wiki/core"
  );
  const publicationPath = path.join(root, "wiki");
  const liveDigest = await digestPublicationTree(publicationPath);
  const liveContentOnly = await digestPublicationTreeContentOnly(publicationPath);
  // Effect identity is content-only; live may include seal sidecar after swap.
  assert.equal(liveContentOnly, candidateDigestAtGate);
  assert.ok(liveDigest.length === 64);
  // observed_outcome records published:<liveDigest> (full sealed tree on live)
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const row = db
    .prepare("SELECT observed_outcome, candidate_digest FROM effects WHERE effect_key = ?")
    .get(effect.effectKey) as { observed_outcome: string; candidate_digest: string };
  db.close();
  assert.equal(row.candidate_digest, candidateDigestAtGate);
  assert.match(row.observed_outcome, /^published:[a-f0-9]{64}$/);
  const publishedLive = row.observed_outcome.slice("published:".length);
  assert.equal(publishedLive, liveDigest);
});

test("T5 effect state machine reaches applied only via candidate_ready→applying", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const { runs, runId, pubGate, effect } = await reachPublicationGate(root, workspaceId, "t5-sm");
  t.after(() => runs.close());

  assert.equal(effect.state, "prepared");
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "t5-sm-approve",
      runId,
      gateId: pubGate.gateId,
      gateKind: "publication",
      payloadDigest: pubGate.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const published = await waitForRunState(runs, runId, ["published"], 30_000);
  const finalEffect = published.snapshot.effects.find((e) => e.effectKey === effect.effectKey);
  assert.equal(finalEffect?.state, "applied");

  // Durable event log must record the ADR 0035 effect transitions in order.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const types = (
    db
      .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY event_id")
      .all(runId) as Array<{ type: string }>
  ).map((row) => row.type);
  db.close();
  const preparedAt = types.indexOf("effect.prepared");
  const readyAt = types.indexOf("effect.candidate_ready");
  const applyingAt = types.indexOf("effect.applying");
  const appliedAt = types.indexOf("effect.applied");
  assert.ok(preparedAt >= 0, "missing effect.prepared");
  assert.ok(readyAt > preparedAt, "candidate_ready must follow prepared");
  assert.ok(applyingAt > readyAt, "applying must follow candidate_ready");
  assert.ok(appliedAt > applyingAt, "applied must follow applying");
  assert.ok(types.includes("run.published"));
});
