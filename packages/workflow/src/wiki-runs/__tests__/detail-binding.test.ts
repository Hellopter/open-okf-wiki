/**
 * Phase 2: sealed definition detail_json must survive into PiAttemptInput
 * and across RerunNode generation bumps.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { PiAttemptInput } from "@okf-wiki/contract";
import { openWikiRuns } from "../../wiki-runs.js";
import { loadPiAttemptNodeDetail } from "../scheduler.js";
import {
  approvePlanGate,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  waitForRunState,
} from "./harness.js";

function detailHost(detailJson: string | null): Parameters<typeof loadPiAttemptNodeDetail>[0] {
  return {
    db: {
      prepare: () => ({ get: () => ({ detail_json: detailJson }) }),
    },
  } as unknown as Parameters<typeof loadPiAttemptNodeDetail>[0];
}

test("dynamic Pi nodes reject missing or invalid sealed detail_json", () => {
  const host = detailHost(null);
  assert.throws(
    () => loadPiAttemptNodeDetail(host, "run-1", "research.leaf.core.1", 0, "research.leaf"),
    /research\.leaf\/research\.leaf\.core\.1 requires valid sealed detail_json: detail_json is missing/,
  );
  assert.throws(
    () =>
      loadPiAttemptNodeDetail(
        detailHost("{bad json"),
        "run-1",
        "review.seat.grounding",
        0,
        "review.seat",
      ),
    /detail_json is not JSON/,
  );
  assert.throws(
    () =>
      loadPiAttemptNodeDetail(
        detailHost(JSON.stringify({ domainId: "core", question: "What?", scope: "src/" })),
        "run-1",
        "research.domain.core",
        0,
        "research.domain",
      ),
    /missing detail\.title/,
  );
  assert.throws(
    () =>
      loadPiAttemptNodeDetail(
        detailHost(JSON.stringify({ lens: "grounding" })),
        "run-1",
        "review.seat.grounding",
        0,
        "review.seat",
      ),
    /missing detail\.seatIndex/,
  );
  assert.throws(
    () =>
      loadPiAttemptNodeDetail(
        detailHost(JSON.stringify({ feedback: "Fix it" })),
        "run-1",
        "repair.1",
        0,
        "repair",
      ),
    /missing detail\.repairRequest/,
  );
});

test("buildPiAttemptInput binds sealed leaf question from detail_json", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const leafDetails: Array<PiAttemptInput["node"]["detail"]> = [];
  const domainDetails: Array<PiAttemptInput["node"]["detail"]> = [];
  const seatDetails: Array<PiAttemptInput["node"]["detail"]> = [];

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "research.leaf") leafDetails.push(input.node.detail);
      if (input.node.kind === "research.domain") domainDetails.push(input.node.detail);
      if (input.node.kind === "review.seat") seatDetails.push(input.node.detail);
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-detail-bind", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-detail-bind");
  // Reach publication so research + review seats have claimed.
  await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);

  assert.ok(leafDetails.length >= 1, "expected at least one research.leaf claim");
  const firstLeaf = leafDetails[0];
  assert.ok(firstLeaf, "leaf detail present on PiAttemptInput");
  assert.equal(firstLeaf.domainId, "core");
  assert.equal(firstLeaf.questionIndex, 1);
  assert.equal(firstLeaf.question, "What is this repository for?");
  assert.ok(
    !/^Question \d+$/.test(firstLeaf.question ?? ""),
    "must not invent placeholder Question N when sealed question exists",
  );

  assert.ok(domainDetails.length >= 1, "expected research.domain claim");
  const domain = domainDetails[0];
  assert.ok(domain);
  assert.equal(domain.domainId, "core");
  assert.equal(domain.title, "Core");
  assert.ok(Array.isArray(domain.questions));
  assert.ok(
    domain.questions?.includes("What is this repository for?"),
    "domain must receive real questions array",
  );

  assert.ok(seatDetails.length >= 1, "expected review.seat claim");
  assert.ok(
    seatDetails.some((d) => typeof d?.lens === "string" && d.lens.length > 0),
    "review.seat must carry sealed lens",
  );
});

test("RerunNode copies prior detail_json and merges feedback on the root target", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-rerun-detail", intent: { mode: "generate" } },
    context(workspaceId),
  );
  // Freeze → plan ready is enough; seed a leaf with definition detail and rerun it.
  await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const timestamp = new Date().toISOString();
  const leafKey = "research.leaf.core.1";
  const leafDetail = {
    domainId: "core",
    questionIndex: 1,
    question: "What is this repository for?",
    scope: "Repository entry points",
    title: "Core",
  };
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, ?, 'research.leaf', 'succeeded', 0, NULL, NULL, ?)`,
  ).run(receipt.runId, leafKey, JSON.stringify(leafDetail));
  // Downstream consumer so lineage invalidation has something to copy.
  db.prepare(
    `INSERT INTO nodes (run_id, node_key, kind, state, generation, current_attempt_id, last_attempt_id, detail_json)
     VALUES (?, 'research.domain.core', 'research.domain', 'succeeded', 0, NULL, NULL, ?)`,
  ).run(
    receipt.runId,
    JSON.stringify({
      domainId: "core",
      title: "Core",
      scope: "Repository entry points",
      questions: ["What is this repository for?"],
    }),
  );
  const leafAttemptId = "attempt-leaf-detail-1";
  const domainAttemptId = "attempt-domain-detail-1";
  const artifactId = `${receipt.runId}:receipt:${"f".repeat(64)}`;
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, ?, 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(leafAttemptId, receipt.runId, leafKey, "a".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, digest, relative_path, producer_attempt_id, sealed_at)
     VALUES (?, ?, 'receipt', ?, 'artifacts/leaf-receipt', ?, ?)`,
  ).run(artifactId, receipt.runId, "f".repeat(64), leafAttemptId, timestamp);
  db.prepare(
    `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
     VALUES (?, ?, 0, 'research', ?)`,
  ).run(receipt.runId, leafKey, artifactId);
  db.prepare(
    `INSERT INTO attempts (
      attempt_id, run_id, node_key, node_generation, run_index, state, input_digest, error, started_at, ended_at
    ) VALUES (?, ?, 'research.domain.core', 0, 1, 'succeeded', ?, NULL, ?, ?)`,
  ).run(domainAttemptId, receipt.runId, "b".repeat(64), timestamp, timestamp);
  db.prepare(
    `INSERT INTO attempt_inputs (attempt_id, role, artifact_id) VALUES (?, 'research', ?)`,
  ).run(domainAttemptId, artifactId);
  db.prepare("UPDATE runs SET state = 'running', updated_at = ? WHERE run_id = ?").run(
    timestamp,
    receipt.runId,
  );
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  const rerunRevision = (await reopened.read({ runId: receipt.runId })).snapshot.revision;
  await reopened.dispatch(
    {
      type: "rerun_node",
      commandId: "rerun-leaf-detail",
      runId: receipt.runId,
      expectedRevision: rerunRevision,
      nodeKey: leafKey,
      generation: 0,
      feedback: "Narrow to runtime entry points only.",
    },
    context(workspaceId),
  );
  await reopened.close();

  const dbAfter = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const leafGen1 = dbAfter
    .prepare("SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = ? AND generation = 1")
    .get(receipt.runId, leafKey) as { detail_json: string | null };
  const domainGen1 = dbAfter
    .prepare(
      "SELECT detail_json FROM nodes WHERE run_id = ? AND node_key = 'research.domain.core' AND generation = 1",
    )
    .get(receipt.runId) as { detail_json: string | null };
  dbAfter.close();

  const leafParsed = JSON.parse(leafGen1.detail_json ?? "null") as Record<string, unknown>;
  assert.equal(leafParsed.question, "What is this repository for?");
  assert.equal(leafParsed.domainId, "core");
  assert.equal(leafParsed.questionIndex, 1);
  assert.equal(leafParsed.feedback, "Narrow to runtime entry points only.");

  const domainParsed = JSON.parse(domainGen1.detail_json ?? "null") as Record<string, unknown>;
  assert.equal(domainParsed.domainId, "core");
  assert.equal(domainParsed.title, "Core");
  assert.deepEqual(domainParsed.questions, ["What is this repository for?"]);
  assert.equal(domainParsed.feedback, undefined, "non-root copy must not invent feedback");
});
