import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  approvePlanGate,
  assertFreezeAdvancedToPlan,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForRunState,
  waitForTerminal,
} from "./harness.js";

test("RerunNode rejects a plan after execution topology is materialized", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  const freezeOutput = finished.snapshot.nodes
    .find((node) => node.key === "freeze")
    ?.outputs.find((output) => output.role === "sources");
  assert.ok(freezeOutput);
  assert.equal(finished.snapshot.nodes.find((node) => node.key === "plan")?.state, "ready");
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const timestamp = new Date().toISOString();
  // Freeze already created plan@0 ready; promote it to succeeded with a Spec output.
  db.prepare(
    `UPDATE nodes SET state = 'succeeded', current_attempt_id = NULL
     WHERE run_id = ? AND node_key = 'plan' AND generation = 0`,
  ).run(receipt.runId);
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'research.domain.main', 'research.domain', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(receipt.runId);
  const planAttemptId = "attempt-plan-1";
  const researchAttemptId = "attempt-research-1";
  const planArtifactId = `${receipt.runId}:spec:${"c".repeat(64)}`;
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, 'plan', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(planAttemptId, receipt.runId, "d".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
     VALUES (?, ?, 'spec', ?, 'artifacts/spec-plan', ?, ?)`,
  ).run(planArtifactId, receipt.runId, "c".repeat(64), planAttemptId, timestamp);
  db.prepare(
    `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
     VALUES (?, 'plan', 0, 'spec', ?)`,
  ).run(receipt.runId, planArtifactId);
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, 'research.domain.main', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(researchAttemptId, receipt.runId, "e".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, 'spec', ?)`,
  ).run(researchAttemptId, planArtifactId);
  // Unrelated node with no lineage should not be invalidated.
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'research.leaf.other', 'research.leaf', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(receipt.runId);
  db.prepare("UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ?").run(
    timestamp,
    receipt.runId,
  );
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  const reopenedRevision = (await reopened.read({ runId: receipt.runId })).snapshot.revision;
  await assert.rejects(
    () =>
      reopened.dispatch(
        {
          type: "rerun_node",
          commandId: "rerun-plan-after-materialization",
          runId: receipt.runId,
          expectedRevision: reopenedRevision,
          nodeKey: "plan",
          generation: 0,
          feedback: "Re-plan with tighter leaf scope.",
        },
        context(workspaceId),
      ),
    /plan.*topology.*materialized|new run/i,
  );
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  const plan = snapshot.nodes.find((node) => node.key === "plan");
  const research = snapshot.nodes.find((node) => node.key === "research.domain.main");
  const other = snapshot.nodes.find((node) => node.key === "research.leaf.other");
  assert.equal(plan?.generation, 0);
  assert.equal(plan?.state, "succeeded");
  assert.equal(research?.generation, 0);
  assert.equal(research?.state, "succeeded");
  assert.equal(other?.generation, 0);
  assert.equal(other?.state, "succeeded");
  await reopened.close();
});

test("RerunNode permits plan revision before execution topology is materialized", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-ready", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  assertFreezeAdvancedToPlan(finished.snapshot);
  const plan = finished.snapshot.nodes.find((node) => node.key === "plan");
  assert.equal(plan?.state, "ready");
  assert.equal(plan?.generation, 0);

  await runs.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-ready-plan",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      nodeKey: "plan",
      generation: 0,
      feedback: "Bump before claim.",
    },
    context(workspaceId),
  );

  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.nodes.find((node) => node.key === "plan")?.generation, 1);
  assert.equal(snapshot.nodes.find((node) => node.key === "plan")?.state, "ready");
  await runs.close();

  // Owner uses EXCLUSIVE locking; inspect superseded generations only after close.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const planRows = db
    .prepare(
      "SELECT generation, state FROM nodes WHERE run_id = ? AND node_key = 'plan' ORDER BY generation",
    )
    .all(receipt.runId) as Array<{ generation: number; state: string }>;
  db.close();
  assert.deepEqual(
    planRows.map((row) => ({ generation: row.generation, state: row.state })),
    [
      { generation: 0, state: "cancelled" },
      { generation: 1, state: "ready" },
    ],
  );
  const claimable = planRows.filter((row) =>
    ["ready", "running", "blocked", "waiting"].includes(row.state),
  );
  assert.equal(claimable.length, 1);
  assert.equal(claimable[0]?.generation, 1);
});

test("RerunNode replaces the open plan gate before execution topology is materialized", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-open-plan", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const atPlanGate = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const firstGate = atPlanGate.snapshot.gates.find(
    (gate) => gate.kind === "plan" && gate.state === "open",
  );
  assert.ok(firstGate, "first plan execution must open a plan gate");

  await runs.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-open-plan",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      nodeKey: "plan",
      generation: 0,
      feedback: "Use a narrower scope.",
    },
    context(workspaceId),
  );

  let after = await runs.read({ runId: receipt.runId });
  for (let i = 0; i < 240; i += 1) {
    after = await runs.read({ runId: receipt.runId });
    if (after.snapshot.nodes.find((node) => node.key === "plan")?.generation === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(after.snapshot.nodes.find((node) => node.key === "plan")?.generation, 1);
  assert.equal(
    after.snapshot.gates.find((gate) => gate.gateId === firstGate.gateId)?.state,
    "withdrawn",
  );
  assert.equal(after.snapshot.nodes.find((node) => node.key === "gate.plan")?.generation, 0);
  assert.equal(after.snapshot.nodes.find((node) => node.key === "gate.plan")?.state, "cancelled");
});

test("failed leaf Retry reuses input_digest and does not re-run succeeded sibling leaves", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const leafAttempts = new Map<string, number>();
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "research.leaf") {
        const next = (leafAttempts.get(input.node.key) ?? 0) + 1;
        leafAttempts.set(input.node.key, next);
        // Exhaust research auto-retry (attempts 1–2 fail); attempt 3 is manual Retry.
        if (input.node.key === "research.leaf.core.1" && next <= 2) {
          return {
            type: "failed",
            error: `fixture leaf failure #${next}`,
            failureClass: "infrastructure",
          };
        }
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-leaf-retry", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-leaf-retry");

  // Wait until leaf.1 is failed after auto-retry exhaustion and leaf.2 succeeded.
  let failedLeafAttemptId: string | undefined;
  let firstInputDigest: string | undefined;
  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    const leaf2 = snapshot.nodes.find((n) => n.key === "research.leaf.core.2");
    const leaf1Attempts = snapshot.attempts.filter((a) => a.nodeKey === "research.leaf.core.1");
    if (leaf1?.state === "failed" && leaf2?.state === "succeeded" && leaf1Attempts.length >= 2) {
      const last = leaf1Attempts.at(-1)!;
      failedLeafAttemptId = last.attemptId;
      firstInputDigest = leaf1Attempts[0]!.inputDigest;
      assert.equal(last.inputDigest, firstInputDigest, "auto-retry reuses exact input_digest");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(failedLeafAttemptId, "leaf.1 should fail after auto-retry budget");
  assert.ok(firstInputDigest);
  const leaf2AttemptsBefore = leafAttempts.get("research.leaf.core.2") ?? 0;
  assert.ok(leaf2AttemptsBefore >= 1, "sibling leaf should have succeeded once");
  const leaf1AttemptsBefore = leafAttempts.get("research.leaf.core.1") ?? 0;

  await runs.dispatch(
    {
      type: "retry_failed_node",
      commandId: "retry-leaf-1",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      nodeKey: "research.leaf.core.1",
      generation: 0,
      attemptId: failedLeafAttemptId,
    },
    context(workspaceId),
  );

  // Wait for leaf.1 manual retry success; domain may then advance.
  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    if (leaf1?.state === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(after.nodes.find((n) => n.key === "research.leaf.core.1")?.state, "succeeded");
  assert.equal(after.nodes.find((n) => n.key === "research.leaf.core.2")?.state, "succeeded");
  assert.equal(
    leafAttempts.get("research.leaf.core.2") ?? 0,
    leaf2AttemptsBefore,
    "succeeded sibling must not be re-executed on leaf Retry",
  );
  assert.equal(
    leafAttempts.get("research.leaf.core.1") ?? 0,
    leaf1AttemptsBefore + 1,
    "failed leaf gets exactly one manual retry Attempt",
  );
  const leaf1Digests = after.attempts
    .filter((a) => a.nodeKey === "research.leaf.core.1")
    .map((a) => a.inputDigest);
  assert.ok(leaf1Digests.length >= 3);
  assert.ok(
    leaf1Digests.every((d) => d === firstInputDigest),
    "every leaf.1 Attempt reuses the same frozen input_digest",
  );
});

test("RerunNode on write.root invalidates validate/review lineage and unlocks after re-success", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const writeClaims: string[] = [];
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "write.root") writeClaims.push(input.attemptId);
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-write", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-rerun-write");

  // Reach publication gate so write/validate/review have sealed outputs + lineage.
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "write.root")?.state, "succeeded");
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "validate.pre")?.state, "succeeded");
  assert.ok(atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"));
  const writeBefore = writeClaims.length;
  assert.ok(writeBefore >= 1);

  const writeGen = atPub.snapshot.nodes.find((n) => n.key === "write.root")!.generation;
  await runs.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-write-root",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      nodeKey: "write.root",
      generation: writeGen,
      feedback: "Tighten overview citations.",
    },
    context(workspaceId),
  );

  const mid = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(mid.nodes.find((n) => n.key === "write.root")?.generation, writeGen + 1);
  // Scheduler may claim the new generation before this read; ready|running|succeeded are all valid.
  assert.ok(
    ["ready", "running", "succeeded"].includes(
      mid.nodes.find((n) => n.key === "write.root")?.state ?? "",
    ),
  );
  // Lineage consumers of wiki_tree advance to gen+1 (invalidated until upstreams re-succeed).
  const validate = mid.nodes.find((n) => n.key === "validate.pre");
  if (validate && validate.generation > writeGen) {
    assert.ok(
      ["invalidated", "ready", "running", "succeeded", "blocked"].includes(validate.state),
      `validate.pre@${validate.generation} unexpected state ${validate.state}`,
    );
  }
  // Unrelated research leaves stay at gen 0 succeeded.
  const leaf = mid.nodes.find((n) => n.kind === "research.leaf");
  assert.equal(leaf?.generation, 0);
  assert.equal(leaf?.state, "succeeded");

  // Scheduler re-runs write then unlocks invalidated descendants through to a new publication gate.
  const atPub2 = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(writeClaims.length > writeBefore, "write.root must execute again after Rerun");
  assert.equal(atPub2.snapshot.nodes.find((n) => n.key === "write.root")?.state, "succeeded");
  assert.equal(atPub2.snapshot.nodes.find((n) => n.key === "write.root")?.generation, writeGen + 1);
  assert.ok(
    atPub2.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "new publication gate after repair lineage",
  );
  // Feedback persisted on the new write generation.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const detail = db
    .prepare(
      "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'write.root' AND generation = ?",
    )
    .get(receipt.runId, writeGen + 1) as { detail_json: string | null };
  db.close();
  assert.deepEqual(JSON.parse(detail.detail_json ?? "null"), {
    feedback: "Tighten overview citations.",
  });
});

test("RerunNode rejects write.root after its model candidate budget is exhausted", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") {
        const spec = defaultWikiRunSpec("Workflow test");
        spec.acceptance.maxCandidates = 1;
        return succeededPlan(input, "Workflow test", spec);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-candidate-cap", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-rerun-candidate-cap");
  const atPublication = await waitForRunState(
    runs,
    receipt.runId,
    ["waiting_for_operator"],
    60_000,
  );
  const writer = atPublication.snapshot.nodes.find((node) => node.key === "write.root");
  assert.equal(writer?.state, "succeeded");
  assert.equal(writer?.generation, 0);

  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "rerun_node",
          commandId: "rerun-write-after-candidate-cap",
          runId: receipt.runId,
          expectedRevision: atPublication.snapshot.revision,
          nodeKey: "write.root",
          generation: 0,
        },
        context(workspaceId),
      ),
    /write\.root.*candidate cap reached \(1\/1\)/,
  );
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(after.nodes.find((node) => node.key === "write.root")?.generation, 0);
});

test("RerunNode rejects repair node keys before they can mint an unbudgeted candidate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-repair", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const repairNodeRevision = (await runs.read({ runId: receipt.runId })).snapshot.revision;

  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "rerun_node",
          commandId: "rerun-repair-1",
          runId: receipt.runId,
          expectedRevision: repairNodeRevision,
          nodeKey: "repair.1",
          generation: 0,
        },
        context(workspaceId),
      ),
    /cannot rerun a repair node/,
  );
});

test("research auto-retry re-queues once on infrastructure; further failure stays manual", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let leaf1Count = 0;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "research.leaf.core.1") {
        leaf1Count += 1;
        // Always fail this leaf so auto-retry exhausts and node ends failed.
        // infrastructure (post-L0 transport) is the typed class L_control may requeue.
        return {
          type: "failed",
          error: "persistent research flake",
          failureClass: "infrastructure",
        };
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(async () => {
    await runs.close();
  });

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-auto-retry", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-auto-retry");

  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    if (leaf1?.state === "failed" && leaf1Count >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(leaf1Count, 2, "research auto-retry allows exactly one extra Attempt");
  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.nodes.find((n) => n.key === "research.leaf.core.1")?.state, "failed");
  const leaf1Attempts = snapshot.attempts.filter((a) => a.nodeKey === "research.leaf.core.1");
  const digests = leaf1Attempts.map((a) => a.inputDigest);
  assert.equal(digests.length, 2);
  assert.equal(digests[0], digests[1]);
  for (const attempt of leaf1Attempts) {
    assert.equal(
      attempt.failureClass,
      "infrastructure",
      "failed research Attempts persist failureClass on snapshot",
    );
  }
  // Drain sibling/background Attempts before the next test file can see rejections.
  await runs.close();
});

test("capacity failure does not auto-requeue research", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let leaf1Count = 0;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "research.leaf.core.1") {
        leaf1Count += 1;
        return {
          type: "failed",
          error: "context overflow / compact-and-retry exhausted",
          failureClass: "capacity",
        };
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(async () => {
    await runs.close();
  });

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-capacity-no-retry", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-capacity-no-retry");

  for (let count = 0; count < 400; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const leaf1 = snapshot.nodes.find((n) => n.key === "research.leaf.core.1");
    if (leaf1?.state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(leaf1Count, 1, "capacity must never auto-requeue a second Attempt");
  const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.nodes.find((n) => n.key === "research.leaf.core.1")?.state, "failed");
  const leaf1Attempts = snapshot.attempts.filter((a) => a.nodeKey === "research.leaf.core.1");
  assert.equal(leaf1Attempts.length, 1);
  assert.equal(
    leaf1Attempts[0]?.failureClass,
    "capacity",
    "capacity fail persists failureClass on snapshot",
  );
  // Drain sibling/background Attempts so seal races do not leak as unhandled rejections.
  await runs.close();
});

test("pre-pin freeze Retry remains banned; post-pin plan Retry works for any failed kind", async (t) => {
  // Post-pin plan failure → RetryFailedNode reuses digest (covers non-research kinds).
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let planFails = 1;
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.key === "plan" && planFails > 0) {
        planFails -= 1;
        return {
          type: "failed",
          error: "plan fixture failure",
          failureClass: "infrastructure",
        };
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-plan-retry", intent: { mode: "generate" } },
    context(workspaceId),
  );
  // Wait for plan failed (freeze already pinned).
  let planAttemptId: string | undefined;
  let planDigest: string | undefined;
  for (let count = 0; count < 300; count += 1) {
    const snapshot = (await runs.read({ runId: receipt.runId })).snapshot;
    const plan = snapshot.nodes.find((n) => n.key === "plan");
    const attempt = snapshot.attempts
      .filter((a) => a.nodeKey === "plan" && a.state === "failed")
      .at(-1);
    if (plan?.state === "failed" && attempt) {
      planAttemptId = attempt.attemptId;
      planDigest = attempt.inputDigest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(planAttemptId);
  assert.ok(planDigest);

  await runs.dispatch(
    {
      type: "retry_failed_node",
      commandId: "retry-plan",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      nodeKey: "plan",
      generation: 0,
      attemptId: planAttemptId,
    },
    context(workspaceId),
  );

  const atGate = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  assert.ok(atGate.snapshot.gates.some((g) => g.kind === "plan" && g.state === "open"));
  const planAttempts = atGate.snapshot.attempts.filter((a) => a.nodeKey === "plan");
  assert.ok(planAttempts.length >= 2);
  assert.ok(planAttempts.every((a) => a.inputDigest === planDigest));
});
