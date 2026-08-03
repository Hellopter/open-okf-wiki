/**
 * Plan revise binds prior_spec for the next plan generation (ADR 0036 / 0040).
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  waitForRunState,
} from "./harness.js";

test("plan revise stores priorSpecArtifactId and binds prior_spec on next claim", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-prior-spec", intent: { mode: "generate" } },
    context(workspaceId),
  );

  const atPlan = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = atPlan.snapshot.gates.find((g) => g.kind === "plan" && g.state === "open");
  assert.ok(planGate, "plan gate opens");

  const planNode = atPlan.snapshot.nodes.find((n) => n.key === "plan");
  assert.equal(planNode?.generation, 0);
  assert.equal(planNode?.state, "succeeded");
  const specOut = planNode?.outputs.find((o) => o.role === "spec");
  assert.ok(specOut?.artifact.artifactId, "gen0 sealed Spec");
  const priorSpecArtifactId = specOut!.artifact.artifactId;

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "revise-prior-spec",
      runId: receipt.runId,
      expectedRevision: atPlan.snapshot.revision,
      gateId: planGate.gateId,
      gateKind: "plan",
      payloadDigest: planGate.payloadDigest,
      decision: "revise",
      feedback: "Cover the second source more carefully.",
    },
    context(workspaceId),
  );

  // Wait until plan gen1 has been claimed (and preferably completed) so attempt_inputs exist.
  let sawGen1 = false;
  for (let i = 0; i < 200; i += 1) {
    const snap = (await runs.read({ runId: receipt.runId })).snapshot;
    const plan = snap.nodes.find((n) => n.key === "plan");
    if (plan && plan.generation >= 1) {
      sawGen1 = true;
      // Prefer terminal-ish states so the attempt_inputs row is durable.
      if (plan.state === "succeeded" || plan.state === "waiting" || plan.state === "failed") break;
      if (
        snap.attempts.some(
          (a) => a.nodeKey === "plan" && a.nodeGeneration === 1 && a.state !== "running",
        )
      ) {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(sawGen1, "plan gen1 should exist after revise");

  // Close owner before opening a second SQLite connection (EXCLUSIVE lock).
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());

  const detailRow = db
    .prepare(
      `SELECT detail_json FROM nodes
       WHERE run_id = ? AND node_key = 'plan' AND generation = 1`,
    )
    .get(receipt.runId) as { detail_json: string | null } | undefined;
  assert.ok(detailRow?.detail_json, "plan gen1 has detail_json");
  const detail = JSON.parse(String(detailRow.detail_json)) as Record<string, unknown>;
  assert.equal(detail.feedback, "Cover the second source more carefully.");
  assert.equal(detail.priorSpecArtifactId, priorSpecArtifactId);

  const attempt = db
    .prepare(
      `SELECT attempt_id FROM attempts
       WHERE run_id = ? AND node_key = 'plan' AND node_generation = 1
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(receipt.runId) as { attempt_id: string } | undefined;
  assert.ok(attempt?.attempt_id, "plan gen1 attempt was claimed");

  const rows = db
    .prepare(
      `SELECT role, artifact_id FROM attempt_inputs
       WHERE attempt_id = ? ORDER BY role`,
    )
    .all(attempt.attempt_id) as Array<{ role: string; artifact_id: string }>;
  const prior = rows.find((r) => r.role === "prior_spec");
  assert.ok(prior, "plan gen1 attempt_inputs must include prior_spec");
  assert.equal(prior.artifact_id, priorSpecArtifactId);
});
