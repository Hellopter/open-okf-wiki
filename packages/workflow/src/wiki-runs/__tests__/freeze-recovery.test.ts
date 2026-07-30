import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadWorkspace, saveWorkspace } from "@okf-wiki/core";
import { openWikiRuns, WorkflowInUseError } from "../../wiki-runs.js";
import {
  assertFreezeAdvancedToPlan,
  context,
  makeWorkspace,
  PLAN_PAYLOAD_DIGEST,
  removeWorkspace,
  seedOpenPlanGate,
  startChildOwner,
  stopChild,
  succeededPlan,
  waitForChildMessage,
  waitForTerminal,
} from "./harness.js";

test("freeze pins real Git and Skill inputs", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-pin", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const { snapshot } = await waitForTerminal(runs, receipt.runId);
  assertFreezeAdvancedToPlan(snapshot);
  assert.equal(snapshot.pinnedInputs?.sources[0]?.id, "main");
  assert.ok(snapshot.pinnedInputs?.sources[0]?.revision);
  assert.match(snapshot.pinnedInputs?.skillDigest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    await readFile(
      path.join(root, ".okf-wiki", "runs", receipt.runId, "sources", "main", "README.md"),
      "utf8",
    ),
    "# source\n",
  );
  assert.deepEqual(
    snapshot.nodes[0]?.outputs.map((output) => output.role),
    ["attempt_output", "frozen_run_manifest", "skill", "sources"],
  );
  const attemptOutput = snapshot.nodes[0]?.outputs.find(
    (output) => output.role === "attempt_output",
  );
  assert.ok(attemptOutput);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(
          root,
          ".okf-wiki",
          "runs",
          receipt.runId,
          "artifacts",
          `manifest-${attemptOutput.artifact.digest}`,
          ".okf-artifact-manifest.json",
        ),
        "utf8",
      ),
    ).schema,
    1,
  );
});

test("Pi receives canonical sealed source and skill artifacts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input) => {
      assert.equal(input.node.kind, "plan");
      const { skillPath, sourcePaths } = input;
      const sourcePath = sourcePaths.main;
      assert.ok(sourcePath);
      assert.match(sourcePath, /\/artifacts\/snapshot_set-/);
      assert.match(skillPath, /\/artifacts\/skill-/);
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(path.dirname(sourcePath), ".okf-artifact-manifest.json"),
            "utf8",
          ),
        ).schema,
        1,
      );
      assert.equal(
        JSON.parse(await readFile(path.join(skillPath, ".okf-artifact-manifest.json"), "utf8"))
          .schema,
        1,
      );
      return succeededPlan(input);
    },
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-sealed-pi-inputs", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const finished = await waitForTerminal(runs, receipt.runId);
  assert.equal(finished.snapshot.nodes.find((node) => node.key === "freeze")?.state, "succeeded");
  assert.ok(
    finished.snapshot.state === "waiting_for_operator" ||
      finished.snapshot.nodes.find((node) => node.key === "plan")?.state === "ready",
  );
});

test("a pre-pin freeze failure requires a new run instead of reusing mutable selectors", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    // Freeze is a Run Boundary operation. A pre-pin failure must not expose a Pi retry path.
    freezeRunBoundary: async () => {
      throw new Error("fixture freeze failure");
    },
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-unpinned", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const result = await waitForTerminal(runs, receipt.runId);
  const attempt = result.snapshot.attempts[0]!;
  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "retry_failed_node",
          commandId: "retry-unpinned",
          runId: receipt.runId,
          nodeKey: "freeze",
          generation: 0,
          attemptId: attempt.attemptId,
        },
        context(workspaceId),
      ),
    /cannot retry a freeze before its inputs are pinned/,
  );
});

test("same content is sealed as distinct run-scoped artifacts", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  t.after(() => runs.close());
  const first = await runs.dispatch(
    { type: "start_run", commandId: "same-content-1", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const second = await runs.dispatch(
    { type: "start_run", commandId: "same-content-2", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const [firstFinished, secondFinished] = await Promise.all([
    waitForTerminal(runs, first.runId),
    waitForTerminal(runs, second.runId),
  ]);
  const firstSource = firstFinished.snapshot.nodes[0]?.outputs.find(
    (output) => output.role === "sources",
  );
  const secondSource = secondFinished.snapshot.nodes[0]?.outputs.find(
    (output) => output.role === "sources",
  );
  assert.ok(firstSource);
  assert.ok(secondSource);
  assert.equal(firstSource.artifact.digest, secondSource.artifact.digest);
  assert.notEqual(firstSource.artifact.artifactId, secondSource.artifact.artifactId);
  assert.match(firstSource.artifact.artifactId, new RegExp(`^${first.runId}:snapshot_set:`));
  assert.match(secondSource.artifact.artifactId, new RegExp(`^${second.runId}:snapshot_set:`));
});

test("reopen adopts only a prepared, already sealed artifact", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-recover-seal", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const completed = await waitForTerminal(owner, receipt.runId);
  const attempt = completed.snapshot.attempts[0]!;
  await owner.close();

  // Model the crash window after filesystem seal and before the final DB CAS.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("DELETE FROM node_outputs WHERE run_id = ?").run(receipt.runId);
  db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(receipt.runId);
  db.prepare("UPDATE artifact_preparations SET state = 'prepared' WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare("UPDATE attempts SET state = 'running', ended_at = NULL WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare(
    "UPDATE nodes SET state = 'running', current_attempt_id = ? WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(attempt.attemptId, receipt.runId);
  db.prepare(
    "UPDATE runs SET state = 'running', pinned_sources_json = NULL, skill_digest = NULL, pinned_digest = NULL WHERE run_id = ?",
  ).run(receipt.runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const recovered = await reopened.read({ runId: receipt.runId });
  assertFreezeAdvancedToPlan(recovered.snapshot);
  assert.equal(recovered.snapshot.attempts[0]?.state, "succeeded");
  const freeze = recovered.snapshot.nodes.find((node) => node.key === "freeze");
  assert.deepEqual(
    freeze?.outputs.map((output) => output.role),
    ["attempt_output", "frozen_run_manifest", "skill", "sources"],
  );
});

test("recovery rejects a tampered sealed input artifact", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-recover-tampered-input", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const completed = await waitForTerminal(owner, receipt.runId);
  const attempt = completed.snapshot.attempts[0]!;
  const source = completed.snapshot.nodes[0]?.outputs.find((output) => output.role === "sources");
  assert.ok(source);
  await owner.close();

  const sealedReadme = path.join(
    root,
    ".okf-wiki",
    "runs",
    receipt.runId,
    "artifacts",
    `snapshot_set-${source.artifact.digest}`,
    "main",
    "README.md",
  );
  await chmod(path.dirname(sealedReadme), 0o755);
  await chmod(sealedReadme, 0o644);
  await writeFile(sealedReadme, "tampered\n", "utf8");
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  db.prepare("DELETE FROM node_outputs WHERE run_id = ?").run(receipt.runId);
  db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(receipt.runId);
  db.prepare("UPDATE artifact_preparations SET state = 'prepared' WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare("UPDATE attempts SET state = 'running', ended_at = NULL WHERE attempt_id = ?").run(
    attempt.attemptId,
  );
  db.prepare(
    "UPDATE nodes SET state = 'running', current_attempt_id = ? WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(attempt.attemptId, receipt.runId);
  db.prepare(
    "UPDATE runs SET state = 'running', pinned_sources_json = NULL, skill_digest = NULL, pinned_digest = NULL WHERE run_id = ?",
  ).run(receipt.runId);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const recovered = await reopened.read({ runId: receipt.runId });
  assert.equal(recovered.snapshot.state, "failed");
  assert.equal(recovered.snapshot.attempts[0]?.state, "interrupted");
  assert.deepEqual(recovered.snapshot.nodes[0]?.outputs, []);
});

test("a killed owner excludes a second process and its running attempt is recovered", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const child = startChildOwner(root, workspaceId);
  t.after(() => stopChild(child));
  const ready = await waitForChildMessage(child);
  assert.equal(ready.type, "ready", ready.message);
  assert.ok(ready.runId);
  await assert.rejects(
    () => openWikiRuns({ rootPath: root }),
    (error: unknown) => error instanceof WorkflowInUseError && error.code === "WORKFLOW_IN_USE",
  );
  await stopChild(child);

  const recovered = await openWikiRuns({ rootPath: root });
  t.after(() => recovered.close());
  const result = await recovered.read({ runId: ready.runId });
  assert.equal(result.snapshot.state, "failed");
  assert.equal(result.snapshot.nodes[0]?.state, "failed");
  assert.equal(result.snapshot.attempts[0]?.state, "interrupted");
});

test("close interrupts a claimed freeze and reopen never accepts its late completion", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-close", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await owner.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const result = await reopened.read({ runId: receipt.runId });
  assert.equal(result.snapshot.state, "failed");
  assert.equal(result.snapshot.nodes[0]?.state, "failed");
  assert.equal(result.snapshot.attempts[0]?.state, "interrupted");
  assert.equal(result.snapshot.nodes[0]?.currentAttemptId, null);
  assert.equal(result.events.at(-1)?.type, "attempt.interrupted");
});

test("freeze recovery uses its Run snapshot and removes unpinned residual work", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const source = path.join(root, "source");
  await writeFile(path.join(source, "uncommitted.txt"), "make first freeze fail\n", "utf8");

  const owner = await openWikiRuns({ rootPath: root });
  const receipt = await owner.dispatch(
    { type: "start_run", commandId: "start-retry", intent: { mode: "generate" } },
    context(workspaceId),
  );
  assert.equal((await waitForTerminal(owner, receipt.runId)).snapshot.state, "failed");
  await owner.close();
  spawnSync("git", ["add", "."], { cwd: source, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "clean source"], { cwd: source, stdio: "ignore" });

  const residual = path.join(root, ".okf-wiki", "runs", receipt.runId, "sources", "main");
  await mkdir(residual, { recursive: true });
  await writeFile(path.join(residual, "stale.txt"), "incomplete freeze\n", "utf8");
  await chmod(path.join(residual, "stale.txt"), 0o444);
  await chmod(residual, 0o555);

  const changed = await loadWorkspace(root);
  changed.sources[0]!.path = path.join(root, "missing-source");
  await saveWorkspace(changed);

  // This models the later RetryFailedNode transition, intentionally out of scope here.
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.prepare(
    "UPDATE nodes SET state = 'ready', current_attempt_id = NULL WHERE run_id = ? AND node_key = 'freeze' AND generation = 0",
  ).run(receipt.runId);
  db.prepare("UPDATE runs SET state = 'queued' WHERE run_id = ?").run(receipt.runId);
  const keyColumns = db
    .prepare("SELECT name FROM pragma_table_info('nodes') WHERE pk > 0 ORDER BY pk")
    .all() as Array<{ name: string }>;
  db.close();
  assert.deepEqual(
    keyColumns.map((column) => column.name),
    ["run_id", "node_key", "generation"],
  );

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  assertFreezeAdvancedToPlan((await waitForTerminal(reopened, receipt.runId)).snapshot);
  assert.equal(
    await readFile(
      path.join(root, ".okf-wiki", "runs", receipt.runId, "sources", "main", "README.md"),
      "utf8",
    ),
    "# source\n",
  );
  await assert.rejects(() => readFile(path.join(residual, "stale.txt")));
});

test("reopen preserves open gates and does not withdraw them", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-preserve-gate", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await waitForTerminal(runs, receipt.runId);
  await runs.close();
  const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-preserve" });
  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.state, "waiting_for_operator");
  assert.equal(snapshot.gates.length, 1);
  assert.equal(snapshot.gates[0]?.gateId, gateId);
  assert.equal(snapshot.gates[0]?.state, "open");
  assert.equal(snapshot.gates[0]?.kind, "plan");
  assert.equal(snapshot.gates[0]?.payloadDigest, PLAN_PAYLOAD_DIGEST);
});

test("recovery marks applying effects unknown without withdrawing open gates", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root });
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-effect-unknown", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await waitForTerminal(runs, receipt.runId);
  await runs.close();
  const gateId = seedOpenPlanGate(root, receipt.runId, { gateId: "gate-with-effect" });
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const digest = "f".repeat(64);
  db.prepare(
    `INSERT INTO effects (
      effect_key, run_id, publication_node_key, publication_node_generation, gate_id, state,
      request_digest, expected_live_digest, candidate_artifact_id, candidate_digest, observed_outcome
    ) VALUES (?, ?, 'prepare.publication', 0, ?, 'applying', ?, ?, 'candidate-1', ?, NULL)`,
  ).run(`publish:${receipt.runId}:0`, receipt.runId, gateId, digest, digest, digest);
  db.close();

  const reopened = await openWikiRuns({ rootPath: root });
  t.after(() => reopened.close());
  const snapshot = (await reopened.read({ runId: receipt.runId })).snapshot;
  assert.equal(snapshot.gates[0]?.state, "open");
  assert.equal(snapshot.effects[0]?.state, "unknown");
});
