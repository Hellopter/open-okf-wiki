import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { PiAttemptInput, PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import type { WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForRunState,
} from "./harness.js";

async function waitForSnapshot(
  runs: Awaited<ReturnType<typeof openWikiRuns>>,
  runId: string,
  predicate: (snapshot: WikiRunSnapshot) => boolean,
): Promise<WikiRunSnapshot> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = (await runs.read({ runId })).snapshot;
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for v5 Run condition: ${runId}`);
}

test("v5 rejects stale controls and replans an applied scope change", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root, piAttemptExecutor: fullGraphFixtureExecutor });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "v5-revision-start", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const initial = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = initial.snapshot.gates.find(
    (gate) => gate.kind === "plan" && gate.state === "open",
  );
  assert.ok(planGate);

  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "pause_run",
          commandId: "v5-stale-pause",
          runId: receipt.runId,
          expectedRevision: initial.snapshot.revision - 1,
        },
        context(workspaceId),
      ),
    /stale control revision/,
  );

  await runs.dispatch(
    {
      type: "submit_run_revision",
      commandId: "v5-scope",
      runId: receipt.runId,
      expectedRevision: initial.snapshot.revision,
      kind: "scope_change",
      content: "Limit the wiki to the runtime and publication path.",
    },
    context(workspaceId),
  );
  const replanned = await waitForSnapshot(runs, receipt.runId, (snapshot) =>
    snapshot.gates.some((gate) => gate.kind === "plan" && gate.state === "open"),
  );
  const scope = replanned.revisions.find((revision) => revision.commandId === "v5-scope");
  assert.ok(scope?.appliedAt);
  assert.equal("epochs" in replanned, false);
});

test("pause/resume starts a fresh Attempt from the frozen input envelope", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  let firstPlanStarted!: () => void;
  const firstPlan = new Promise<void>((resolve) => {
    firstPlanStarted = resolve;
  });
  const planInputs: PiAttemptInput[] = [];
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal): Promise<PiAttemptOutcome> => {
      if (input.node.kind !== "plan") return fullGraphFixtureExecutor(input, signal);
      planInputs.push(input);
      if (planInputs.length === 1) {
        firstPlanStarted();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      return succeededPlan(input);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "v5-pause-start", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await firstPlan;
  const running = (await runs.read({ runId: receipt.runId })).snapshot;
  await runs.dispatch(
    {
      type: "pause_run",
      commandId: "v5-pause",
      runId: receipt.runId,
      expectedRevision: running.revision,
    },
    context(workspaceId),
  );
  const paused = await waitForSnapshot(
    runs,
    receipt.runId,
    (snapshot) => snapshot.state === "paused",
  );
  assert.ok(
    paused.attempts.some((attempt) => attempt.nodeKey === "plan" && attempt.state === "suspended"),
  );

  await runs.dispatch(
    {
      type: "resume_run",
      commandId: "v5-resume",
      runId: receipt.runId,
      expectedRevision: paused.revision,
    },
    context(workspaceId),
  );
  await waitForSnapshot(
    runs,
    receipt.runId,
    (snapshot) =>
      snapshot.gates.some((gate) => gate.kind === "plan" && gate.state === "open") &&
      snapshot.attempts.filter((attempt) => attempt.nodeKey === "plan").length === 2,
  );
  assert.equal(planInputs.length, 2);
  assert.equal(planInputs[0]?.inputDigest, planInputs[1]?.inputDigest);
});

test("candidate review validates paths and anchors before scheduling one repair batch", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({ rootPath: root, piAttemptExecutor: fullGraphFixtureExecutor });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "v5-review-start", intent: { mode: "generate" } },
    context(workspaceId),
  );
  const planned = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"]);
  const planGate = planned.snapshot.gates.find(
    (gate) => gate.kind === "plan" && gate.state === "open",
  );
  assert.ok(planGate);
  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "v5-review-approve-plan",
      runId: receipt.runId,
      expectedRevision: planned.snapshot.revision,
      gateId: planGate!.gateId,
      gateKind: "plan",
      payloadDigest: planGate!.payloadDigest,
      decision: "approve",
    },
    context(workspaceId),
  );
  const candidateSnapshot = await waitForSnapshot(
    runs,
    receipt.runId,
    (snapshot) => snapshot.candidates.length > 0,
  );
  const candidate = candidateSnapshot.candidates.at(-1);
  assert.ok(candidate);
  const tree = await runs.readCandidateTree({
    runId: receipt.runId,
    candidateDigest: candidate!.digest,
  });
  assert.ok(tree.pages.includes("overview.md"), "tree is sourced from the sealed evidence map");
  const page = await runs.readCandidatePage({
    runId: receipt.runId,
    candidateDigest: candidate!.digest,
    pagePath: "overview.md",
  });
  assert.ok(page.evidence.some((evidence) => evidence.source.startsWith("repo:")));
  await assert.rejects(
    () =>
      runs.readCandidatePage({
        runId: receipt.runId,
        candidateDigest: candidate!.digest,
        pagePath: "../workspace.json",
      }),
    /candidate page path is invalid/,
  );

  const selectedText = page.content.replace(/\r\n/g, "\n").split("\n").slice(0, 1).join("\n");
  await runs.dispatch(
    {
      type: "create_review_thread",
      commandId: "v5-review-comment",
      runId: receipt.runId,
      expectedRevision: candidateSnapshot.revision,
      anchor: {
        candidateDigest: candidate!.digest,
        pagePath: "overview.md",
        startLine: 1,
        endLine: 1,
      },
      body: "Clarify the page metadata for readers.",
    },
    context(workspaceId),
  );
  const threaded = await waitForSnapshot(
    runs,
    receipt.runId,
    (snapshot) => snapshot.reviewThreads.length === 1,
  );
  const thread = threaded.reviewThreads[0];
  assert.ok(thread);
  assert.equal(thread.selectedTextDigest, createHash("sha256").update(selectedText).digest("hex"));
  await runs.dispatch(
    {
      type: "request_repair",
      commandId: "v5-review-repair",
      runId: receipt.runId,
      expectedRevision: threaded.revision,
      threadIds: [thread!.threadId],
    },
    context(workspaceId),
  );
  const repaired = await waitForSnapshot(runs, receipt.runId, (snapshot) =>
    snapshot.nodes.some((node) => node.key.startsWith("repair.")),
  );
  assert.ok(repaired.reviewThreads.some((item) => item.threadId === thread!.threadId));
});
