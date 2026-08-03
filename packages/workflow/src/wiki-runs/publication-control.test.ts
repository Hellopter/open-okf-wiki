/**
 * Unit tests for publication apply control (conflict gate reopen / run park).
 * Uses openControlFixture — no full scheduler / filesystem apply.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginPublicationApply,
  onPublicationApplyResult,
  type PublicationApplyBinding,
} from "./publication-control.js";
import { insertPreparedEffect, transitionPreparedToCandidateReady } from "./publication-effect.js";
import { asRow, requiredText } from "./sql.js";
import { openControlFixture } from "./testing/control-fixture.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function seedPublicationApplyScene(db: import("node:sqlite").DatabaseSync): PublicationApplyBinding {
  const ts = "2026-08-03T12:00:00.000Z";
  const runId = "run-pub-ctrl";
  const gateId = "gate-pub-1";
  const effectKey = `publish:${runId}:0:${DIGEST_A}`;
  const publicationNodeKey = "prepare.publication";
  const publicationNodeGeneration = 0;

  db.prepare(
    `INSERT INTO runs (
       run_id, workspace_id, definition_version, revision, state, cancel_requested,
       freeze_config_json, freeze_config_digest, created_at, updated_at
     ) VALUES (?, 'ws-1', 5, 3, 'running', 0, '{}', 'deadbeef', ?, ?)`,
  ).run(runId, ts, ts);

  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'prepare.publication', 'prepare.publication', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(runId);
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'gate.publication', 'gate.publication', 'succeeded', 0, NULL, NULL, NULL)`,
  ).run(runId);
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'publish', 'publish', 'running', 0, 'att-publish', NULL, NULL)`,
  ).run(runId);

  db.prepare(
    `INSERT INTO attempts (
       attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, started_at
     ) VALUES ('att-seed', ?, 'prepare.publication', 0, 0, 'succeeded', ?, ?)`,
  ).run(runId, DIGEST_A, ts);

  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
     VALUES ('art-cand', ?, 'publication_candidate', ?, 'artifacts/cand', 'att-seed', ?)`,
  ).run(runId, DIGEST_C, ts);

  db.prepare(
    `INSERT INTO gates (
       gate_id, run_id, node_key, node_generation, kind, state, payload_digest,
       decision_json, detail_json, opened_at, opened_revision
     ) VALUES (?, ?, 'gate.publication', 0, 'publication', 'resolved', ?,
       ?, NULL, ?, 1)`,
  ).run(
    gateId,
    runId,
    DIGEST_A,
    JSON.stringify({ decision: "approve", actorId: "op", decidedAt: ts }),
    ts,
  );

  return {
    runId,
    effectKey,
    gateId,
    publicationNodeKey,
    publicationNodeGeneration,
  };
}

test("onPublicationApplyResult conflict reopens gate, parks run, does not fail run", async () => {
  const fixture = await openControlFixture();
  try {
    const binding = seedPublicationApplyScene(fixture.db);
    insertPreparedEffect(fixture.ctrl, {
      effectKey: binding.effectKey,
      runId: binding.runId,
      publicationNodeKey: binding.publicationNodeKey,
      publicationNodeGeneration: binding.publicationNodeGeneration,
      gateId: binding.gateId,
      requestDigest: DIGEST_A,
      expectedLiveDigest: DIGEST_A,
      candidateArtifactId: "art-cand",
      candidateDigest: DIGEST_C,
    });
    assert.ok(transitionPreparedToCandidateReady(fixture.ctrl, binding.runId, binding.effectKey));
    // Simulate beginApply CAS so effect is applying (conflict can also fire from candidate_ready).
    assert.ok(beginPublicationApply(fixture.ctrl, binding));

    onPublicationApplyResult(fixture.ctrl, binding, {
      status: "conflict",
      liveDigest: DIGEST_B,
      expectedLiveDigest: DIGEST_A,
    });

    const effect = asRow(
      fixture.db.prepare("SELECT state, observed_outcome FROM effects WHERE effect_key = ?").get(
        binding.effectKey,
      ),
    );
    assert.ok(effect);
    assert.equal(requiredText(effect, "state"), "conflict");
    assert.match(String(effect.observed_outcome ?? ""), /PublicationConflict/);

    const gate = asRow(
      fixture.db.prepare("SELECT state, decision_json, detail_json FROM gates WHERE gate_id = ?").get(
        binding.gateId,
      ),
    );
    assert.ok(gate);
    assert.equal(requiredText(gate, "state"), "open");
    assert.equal(gate.decision_json, null);
    const detail = JSON.parse(String(gate.detail_json));
    assert.equal(detail.expectedLiveDigest, DIGEST_A);
    assert.equal(detail.observedLiveDigest, DIGEST_B);

    const gateNode = asRow(
      fixture.db
        .prepare(
          "SELECT state FROM nodes WHERE run_id = ? AND node_key = 'gate.publication' AND generation = 0",
        )
        .get(binding.runId),
    );
    assert.equal(requiredText(gateNode!, "state"), "waiting");

    const run = asRow(
      fixture.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(binding.runId),
    );
    assert.equal(requiredText(run!, "state"), "waiting_for_operator");

    // Publish node is still running here — failNode (not this module) blocks it.
    const publish = asRow(
      fixture.db
        .prepare("SELECT state FROM nodes WHERE run_id = ? AND node_key = 'publish' AND generation = 0")
        .get(binding.runId),
    );
    assert.equal(requiredText(publish!, "state"), "running");
  } finally {
    await fixture.close();
  }
});

test("onPublicationApplyResult applied transitions effect only", async () => {
  const fixture = await openControlFixture();
  try {
    const binding = seedPublicationApplyScene(fixture.db);
    insertPreparedEffect(fixture.ctrl, {
      effectKey: binding.effectKey,
      runId: binding.runId,
      publicationNodeKey: binding.publicationNodeKey,
      publicationNodeGeneration: binding.publicationNodeGeneration,
      gateId: binding.gateId,
      requestDigest: DIGEST_A,
      expectedLiveDigest: DIGEST_A,
      candidateArtifactId: "art-cand",
      candidateDigest: DIGEST_C,
    });
    assert.ok(transitionPreparedToCandidateReady(fixture.ctrl, binding.runId, binding.effectKey));
    assert.ok(beginPublicationApply(fixture.ctrl, binding));

    onPublicationApplyResult(fixture.ctrl, binding, {
      status: "applied",
      pageCount: 1,
      liveDigest: DIGEST_C,
    });

    const effect = asRow(
      fixture.db.prepare("SELECT state, observed_outcome FROM effects WHERE effect_key = ?").get(
        binding.effectKey,
      ),
    );
    assert.equal(requiredText(effect!, "state"), "applied");
    assert.equal(effect!.observed_outcome, `published:${DIGEST_C}`);

    // Applied path does not reopen the gate or park the run.
    const gate = asRow(
      fixture.db.prepare("SELECT state FROM gates WHERE gate_id = ?").get(binding.gateId),
    );
    assert.equal(requiredText(gate!, "state"), "resolved");
    const run = asRow(
      fixture.db.prepare("SELECT state FROM runs WHERE run_id = ?").get(binding.runId),
    );
    assert.equal(requiredText(run!, "state"), "running");
  } finally {
    await fixture.close();
  }
});

test("beginPublicationApply rejects cancel_requested and non-approved gate", async () => {
  const fixture = await openControlFixture();
  try {
    const binding = seedPublicationApplyScene(fixture.db);
    insertPreparedEffect(fixture.ctrl, {
      effectKey: binding.effectKey,
      runId: binding.runId,
      publicationNodeKey: binding.publicationNodeKey,
      publicationNodeGeneration: binding.publicationNodeGeneration,
      gateId: binding.gateId,
      requestDigest: DIGEST_A,
      expectedLiveDigest: DIGEST_A,
      candidateArtifactId: "art-cand",
      candidateDigest: DIGEST_C,
    });
    assert.ok(transitionPreparedToCandidateReady(fixture.ctrl, binding.runId, binding.effectKey));

    fixture.db.prepare("UPDATE runs SET cancel_requested = 1 WHERE run_id = ?").run(binding.runId);
    assert.equal(beginPublicationApply(fixture.ctrl, binding), false);

    fixture.db.prepare("UPDATE runs SET cancel_requested = 0 WHERE run_id = ?").run(binding.runId);
    fixture.db
      .prepare("UPDATE gates SET state = 'open', decision_json = NULL WHERE gate_id = ?")
      .run(binding.gateId);
    assert.equal(beginPublicationApply(fixture.ctrl, binding), false);

    // Restore approved gate — CAS succeeds.
    fixture.db
      .prepare(
        `UPDATE gates SET state = 'resolved',
         decision_json = ? WHERE gate_id = ?`,
      )
      .run(JSON.stringify({ decision: "approve" }), binding.gateId);
    assert.equal(beginPublicationApply(fixture.ctrl, binding), true);
    const effect = asRow(
      fixture.db.prepare("SELECT state FROM effects WHERE effect_key = ?").get(binding.effectKey),
    );
    assert.equal(requiredText(effect!, "state"), "applying");
  } finally {
    await fixture.close();
  }
});
