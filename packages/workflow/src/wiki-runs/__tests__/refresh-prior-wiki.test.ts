/**
 * Phase 2: freeze with mode=refresh seals prior_wiki from publicationPath.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadWorkspace } from "@okf-wiki/core";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  freezeAndPlanExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededProbe,
  waitForRunState,
} from "./harness.js";

test("freeze refresh seals prior_wiki; generate does not", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  // Seed a published wiki at the workspace publicationPath.
  const workspace = await loadWorkspace(root);
  await writeFile(
    path.join(workspace.publicationPath, "overview.md"),
    "---\ntype: Overview\ntitle: Published\ndescription: Prior wiki page\n---\n\n# Published\n",
    "utf8",
  );

  const refreshRuns = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async (input) => succeededProbe(input.workDir)),
  });
  t.after(() => refreshRuns.close());

  const refreshReceipt = await refreshRuns.dispatch(
    { type: "start_run", commandId: "start-refresh", intent: { mode: "refresh" } },
    context(workspaceId),
  );
  await waitForRunState(refreshRuns, refreshReceipt.runId, ["waiting_for_operator"], 60_000);
  const refreshSnap = await refreshRuns.read({ runId: refreshReceipt.runId });
  const freezeNode = refreshSnap.snapshot.nodes.find((n) => n.key === "freeze");
  assert.ok(freezeNode);
  assert.equal(freezeNode.state, "succeeded");
  assert.ok(
    freezeNode.outputs.some((o) => o.role === "prior_wiki"),
    `expected prior_wiki in freeze outputs, got ${freezeNode.outputs.map((o) => o.role).join(",")}`,
  );
  const priorOut = freezeNode.outputs.find((o) => o.role === "prior_wiki");
  assert.ok(priorOut);
  assert.equal(priorOut.artifact.kind, "wiki_tree");
  const priorAbs = path.join(
    root,
    ".okf-wiki",
    "runs",
    refreshReceipt.runId,
    "artifacts",
    `wiki_tree-${priorOut.artifact.digest}`,
  );
  const overview = await readFile(path.join(priorAbs, "overview.md"), "utf8");
  assert.ok(overview.includes("Published"));

  // --- generate mode on a fresh workspace: no prior_wiki ---
  const gen = await makeWorkspace();
  t.after(() => removeWorkspace(gen.root));
  const genRuns = await openWikiRuns({
    rootPath: gen.root,
    piAttemptExecutor: freezeAndPlanExecutor(async (input) => succeededProbe(input.workDir)),
  });
  t.after(() => genRuns.close());
  const genReceipt = await genRuns.dispatch(
    { type: "start_run", commandId: "start-gen", intent: { mode: "generate" } },
    context(gen.workspaceId),
  );
  await waitForRunState(genRuns, genReceipt.runId, ["waiting_for_operator"], 60_000);
  const genSnap = await genRuns.read({ runId: genReceipt.runId });
  const genFreeze = genSnap.snapshot.nodes.find((n) => n.key === "freeze");
  assert.ok(genFreeze);
  assert.ok(
    !genFreeze.outputs.some((o) => o.role === "prior_wiki"),
    "generate freeze must not seal prior_wiki",
  );
});

test("freeze refresh fails closed when published wiki is empty", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  // publicationPath exists but has no markdown (makeWorkspace leaves empty wiki/)

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async (input) => succeededProbe(input.workDir)),
  });
  t.after(() => runs.close());
  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-empty-refresh", intent: { mode: "refresh" } },
    context(workspaceId),
  );
  const deadline = Date.now() + 60_000;
  let lastState = "";
  while (Date.now() < deadline) {
    const result = await runs.read({ runId: receipt.runId });
    lastState = result.snapshot.state;
    if (result.snapshot.state === "failed") {
      const freeze = result.snapshot.nodes.find((n) => n.key === "freeze");
      assert.equal(freeze?.state, "failed");
      const failedAttempt = result.snapshot.attempts.find((a) => a.state === "failed");
      assert.ok(
        failedAttempt?.error?.includes("refresh mode requires") ||
          failedAttempt?.error?.includes("published wiki"),
        `expected refresh empty-wiki error, got: ${failedAttempt?.error}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for failed refresh freeze (state=${lastState})`);
});

test("refresh freeze seals prior_wiki artifact digest for lineage", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const workspace = await loadWorkspace(root);
  await writeFile(
    path.join(workspace.publicationPath, "overview.md"),
    "---\ntype: Overview\ntitle: Published\ndescription: Prior\n---\n\n# Published\n",
    "utf8",
  );

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: freezeAndPlanExecutor(async (input) => succeededProbe(input.workDir)),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-refresh-lineage", intent: { mode: "refresh" } },
    context(workspaceId),
  );
  await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  await runs.close();

  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const prior = db
    .prepare(
      `SELECT artifacts.digest, artifacts.relative_path FROM node_outputs
       JOIN artifacts ON artifacts.artifact_id = node_outputs.artifact_id
       WHERE node_outputs.run_id = ? AND node_outputs.node_key = 'freeze'
         AND node_outputs.role = 'prior_wiki'`,
    )
    .get(receipt.runId) as { digest: string; relative_path: string } | undefined;
  assert.ok(prior?.digest, "prior_wiki digest must be sealed on freeze");
  assert.match(prior.digest, /^[a-f0-9]{64}$/i);
  const body = await readFile(
    path.join(root, ".okf-wiki", "runs", receipt.runId, prior.relative_path, "overview.md"),
    "utf8",
  );
  assert.ok(body.includes("Published"));
  db.close();
});
