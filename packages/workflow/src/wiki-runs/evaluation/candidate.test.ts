/**
 * WikiCandidate durable registration unit tests.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { configureOwner, migrate } from "../schema.js";
import {
  assertUnderMaxCandidates,
  countModelWikiCandidates,
  countWikiCandidates,
  latestWikiCandidate,
  listWikiCandidates,
  nextCandidateRound,
  producedByForNode,
  registerWikiCandidate,
  wikiCandidateById,
} from "./candidate.js";

function openMigratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  configureOwner(db);
  migrate(db);
  return db;
}

/** Minimal run row so FK-free candidate table still has a logical run id. */
function seedRun(db: DatabaseSync, runId = "run-1"): void {
  const ts = "2026-07-30T12:00:00.000Z";
  db.prepare(
    `INSERT INTO runs (
       run_id, workspace_id, definition_version, revision, state, cancel_requested,
       freeze_config_json, freeze_config_digest, created_at, updated_at
     ) VALUES (?, 'ws-1', 4, 0, 'running', 0, '{}', 'deadbeef', ?, ?)`,
  ).run(runId, ts, ts);
}

test("migrate creates wiki_candidates table + index", () => {
  const db = openMigratedDb();
  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wiki_candidates'`)
    .get() as { name?: string } | undefined;
  assert.equal(table?.name, "wiki_candidates");
  const index = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_wiki_candidates_run'`,
    )
    .get() as { name?: string } | undefined;
  assert.equal(index?.name, "idx_wiki_candidates_run");
  db.close();
});

test("producedByForNode maps write / repair / validate", () => {
  assert.equal(producedByForNode("write.root", "write.root"), "write");
  assert.equal(producedByForNode("repair", "repair.1"), "repair");
  assert.equal(producedByForNode("repair", "repair.2"), "repair");
  assert.equal(producedByForNode("repair", "repair"), "repair");
  assert.equal(producedByForNode("validate.pre", "validate.pre"), "mechanical_fix");
  assert.equal(producedByForNode("validate.final", "validate.final"), "mechanical_fix");
  assert.equal(producedByForNode("review.reduce", "review.reduce"), "mechanical_fix");
});

test("register two candidates with parent chain, count, latest, list", () => {
  const db = openMigratedDb();
  seedRun(db);
  const host = { db };

  assert.equal(countWikiCandidates(host, "run-1"), 0);
  assert.equal(nextCandidateRound(host, "run-1"), 0);
  assert.equal(latestWikiCandidate(host, "run-1"), undefined);

  const write = registerWikiCandidate(host, {
    runId: "run-1",
    digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    artifactId: "run-1:wiki_tree:aaa",
    producedBy: "write",
    producerNodeKey: "write.root",
    producerAttemptId: "att-write",
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(write.round, 0);
  assert.equal(write.producedBy, "write");
  assert.equal(write.parentCandidateId, undefined);
  assert.equal(write.candidateId, "cand-0-aaaaaaaaaaaa");
  assert.equal(countWikiCandidates(host, "run-1"), 1);
  assert.equal(nextCandidateRound(host, "run-1"), 1);

  const repaired = registerWikiCandidate(host, {
    runId: "run-1",
    digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    artifactId: "run-1:wiki_tree:bbb",
    producedBy: "repair",
    producerNodeKey: "repair.1",
    producerAttemptId: "att-repair",
    createdAt: "2026-07-30T12:01:00.000Z",
  });
  assert.equal(repaired.round, 1);
  assert.equal(repaired.producedBy, "repair");
  assert.equal(repaired.parentCandidateId, write.candidateId);
  assert.equal(repaired.candidateId, "cand-1-bbbbbbbbbbbb");

  const mech = registerWikiCandidate(host, {
    runId: "run-1",
    digest: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    artifactId: "run-1:wiki_tree:ccc",
    producedBy: "mechanical_fix",
    producerNodeKey: "validate.pre",
    producerAttemptId: "att-val",
    createdAt: "2026-07-30T12:02:00.000Z",
  });
  assert.equal(mech.round, 2);
  assert.equal(mech.parentCandidateId, repaired.candidateId);

  assert.equal(countWikiCandidates(host, "run-1"), 3);
  assert.equal(countModelWikiCandidates(host, "run-1"), 2);
  const latest = latestWikiCandidate(host, "run-1");
  assert.ok(latest);
  assert.equal(latest!.candidateId, mech.candidateId);
  assert.equal(wikiCandidateById(host, "run-1", write.candidateId)?.artifactId, write.artifactId);
  assert.equal(wikiCandidateById(host, "run-2", write.candidateId), undefined);

  const listed = listWikiCandidates(host, "run-1");
  assert.deepEqual(
    listed.map((c) => c.candidateId),
    [write.candidateId, repaired.candidateId, mech.candidateId],
  );

  db.close();
});

test("candidate cap counts model proposals rather than mechanical re-seals", () => {
  const db = openMigratedDb();
  seedRun(db);
  const host = { db };

  registerWikiCandidate(host, {
    runId: "run-1",
    digest: "1111111111111111111111111111111111111111111111111111111111111111",
    artifactId: "art-1",
    producedBy: "write",
  });
  registerWikiCandidate(host, {
    runId: "run-1",
    digest: "2222222222222222222222222222222222222222222222222222222222222222",
    artifactId: "art-2",
    producedBy: "repair",
  });

  assert.doesNotThrow(() => assertUnderMaxCandidates(host, "run-1", 3));
  assert.throws(
    () => assertUnderMaxCandidates(host, "run-1", 2),
    /wiki candidate cap reached \(2\/2\)/,
  );

  // Mechanical re-seals remain durable evidence without consuming the model cap.
  const extra = registerWikiCandidate(host, {
    runId: "run-1",
    digest: "3333333333333333333333333333333333333333333333333333333333333333",
    artifactId: "art-3",
    producedBy: "mechanical_fix",
  });
  assert.equal(extra.round, 2);
  assert.equal(countWikiCandidates(host, "run-1"), 3);
  assert.equal(countModelWikiCandidates(host, "run-1"), 2);
  assert.throws(
    () => assertUnderMaxCandidates(host, "run-1", 2),
    /wiki candidate cap reached \(2\/2\)/,
  );

  db.close();
});

test("idempotent re-register of same candidateId returns existing row", () => {
  const db = openMigratedDb();
  seedRun(db);
  const host = { db };

  const first = registerWikiCandidate(host, {
    runId: "run-1",
    digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    artifactId: "art-d",
    producedBy: "write",
    candidateId: "cand-fixed",
    round: 0,
    createdAt: "2026-07-30T12:00:00.000Z",
  });
  const second = registerWikiCandidate(host, {
    runId: "run-1",
    digest: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    artifactId: "art-e",
    producedBy: "repair",
    candidateId: "cand-fixed",
    round: 0,
    createdAt: "2026-07-30T12:99:00.000Z",
  });
  assert.equal(second.candidateId, first.candidateId);
  assert.equal(second.digest, first.digest);
  assert.equal(countWikiCandidates(host, "run-1"), 1);

  db.close();
});
