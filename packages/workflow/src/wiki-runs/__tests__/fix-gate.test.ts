/**
 * Phase F1: gate.fix after review.reduce + repair.review.N on ResolveGate(fix).
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  defaultWikiRunSpec,
  type PiAttemptInput,
  type PiAttemptOutcome,
} from "@okf-wiki/contract";
import { openWikiRuns } from "../../wiki-runs.js";
import { REVIEW_REPAIR_NODE_PREFIX } from "../gates.js";
import {
  approvePlanGate,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  waitForRunState,
} from "./harness.js";

async function writeGoodWiki(workDir: string): Promise<string> {
  const wikiDir = path.join(workDir, "wiki");
  await mkdir(wikiDir, { recursive: true });
  await writeFile(
    path.join(wikiDir, "overview.md"),
    [
      "---",
      "type: Overview",
      'title: "Workflow test"',
      "---",
      "",
      "# Workflow test",
      "",
      "Fixture wiki page.",
      "",
      "Grounding: [Source](repo:README.md#L1).",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, "index.md"),
    "---\ntype: Index\ntitle: Index\n---\n\n# Index\n\n- [Overview](./overview.md)\n",
    "utf8",
  );
  return wikiDir;
}

async function writeSucceeded(
  input: PiAttemptInput,
  wikiDir: string,
  summary: string,
): Promise<PiAttemptOutcome> {
  const transcript = path.join(input.attemptDir, "session.jsonl");
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(
    transcript,
    [
      JSON.stringify({ role: "assistant", content: summary }),
      JSON.stringify({ schema: 1, node: input.node.key, summary }),
    ].join("\n") + "\n",
    "utf8",
  );
  return {
    type: "succeeded",
    unsealedArtifacts: [
      { kind: "wiki_tree", role: "wiki_tree", sourcePath: wikiDir, directory: true },
      { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
    ],
    summary,
  };
}

/** One seat emits blocking defects; others clean. */
function blockingSeatExecutor(
  options?: { maxRepairRounds?: number },
): (input: PiAttemptInput, signal: AbortSignal) => Promise<PiAttemptOutcome> {
  let blockingEmitted = false;
  return async (input, signal) => {
    if (input.node.kind === "plan") {
      const spec = defaultWikiRunSpec("Workflow test");
      if (options?.maxRepairRounds !== undefined) {
        spec.acceptance.maxRepairRounds = options.maxRepairRounds;
      }
      const specPath = path.join(input.workDir, "spec.json");
      await mkdir(input.workDir, { recursive: true });
      await writeFile(specPath, `${JSON.stringify(spec)}\n`, "utf8");
      const transcript = path.join(input.attemptDir, "session.jsonl");
      await writeFile(
        transcript,
        [
          JSON.stringify({ role: "user", content: "Plan" }),
          JSON.stringify({ role: "assistant", content: spec.summary }),
          JSON.stringify({ schema: 1, node: "plan", mode: "fixture", summary: spec.summary }),
        ].join("\n") + "\n",
        "utf8",
      );
      return {
        type: "succeeded",
        unsealedArtifacts: [
          { kind: "spec", role: "spec", sourcePath: specPath, directory: false },
          { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
        ],
        summary: spec.summary,
      };
    }
    if (input.node.kind === "review.seat") {
      await mkdir(path.join(input.workDir, "analysis"), { recursive: true });
      const receipt = path.join(input.workDir, "analysis", `${input.node.key}.json`);
      // First seat only: emit one blocking defect so reduce seals dirty report.
      const blocking = !blockingEmitted;
      if (blocking) blockingEmitted = true;
      const body = blocking
        ? {
            clean: false,
            defects: [
              {
                severity: "blocking",
                code: "missing_citation",
                issue: "overview lacks grounding citations",
                path: "overview.md",
              },
            ],
            summary: "blocking: missing citation",
          }
        : { clean: true, defects: [], summary: "NO_DEFECTS", node: input.node.key };
      await writeFile(receipt, `${JSON.stringify(body)}\n`, "utf8");
      const transcript = path.join(input.attemptDir, "session.jsonl");
      // Include node key so concurrent seats do not collide on identical transcript digests.
      await writeFile(
        transcript,
        [
          JSON.stringify({ role: "assistant", content: body.summary }),
          JSON.stringify({ schema: 1, node: input.node.key, summary: body.summary }),
        ].join("\n") + "\n",
        "utf8",
      );
      return {
        type: "succeeded",
        unsealedArtifacts: [
          { kind: "receipt", role: "review_seat", sourcePath: receipt, directory: false },
          { kind: "transcript", role: "transcript", sourcePath: transcript, directory: false },
        ],
        summary: String(body.summary),
      };
    }
    if (input.node.kind === "repair") {
      await mkdir(input.workDir, { recursive: true });
      const wikiDir = await writeGoodWiki(input.workDir);
      return writeSucceeded(input, wikiDir, "fixture repair.review fix");
    }
    return fullGraphFixtureExecutor(input, signal);
  };
}

test("definition materializes gate.fix between review.reduce and validate.final", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-def-fix" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-def-fix");
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.ok(after.nodes.some((n) => n.key === "gate.fix" && n.kind === "gate.fix"));
});

test("review.reduce with blocking seats succeeds and opens fix gate", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: blockingSeatExecutor(),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-open" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-open");

  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate, "expected open fix gate after blocking review.reduce");
  assert.equal(fixGate.nodeKey, "gate.fix");
  assert.equal(
    atFix.snapshot.nodes.find((n) => n.key === "gate.fix")?.state,
    "waiting",
  );

  const reduce = atFix.snapshot.nodes.find((n) => n.key === "review.reduce");
  assert.equal(reduce?.state, "succeeded", "review.reduce must succeed with sealed defects");
  const reduceAttempt = atFix.snapshot.attempts.find(
    (a) => a.nodeKey === "review.reduce" && a.state === "succeeded",
  );
  assert.ok(reduceAttempt, "review.reduce attempt succeeded (not failed)");
  assert.ok(
    reduce?.outputs.some((o) => o.role === "defects"),
    "defects receipt must be sealed on review.reduce",
  );
});

test("resolve fix pass unlocks validate.final path toward publication", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: blockingSeatExecutor(),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-pass" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-pass");
  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate);

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "pass-fix",
      runId: receipt.runId,
      gateId: fixGate.gateId,
      gateKind: "fix",
      payloadDigest: fixGate.payloadDigest,
      decision: "pass",
    },
    context(workspaceId),
  );

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const pubGate = atPub.snapshot.gates.find((g) => g.kind === "publication" && g.state === "open");
  assert.ok(pubGate, "pass should advance to publication gate");
  assert.equal(
    atPub.snapshot.gates.find((g) => g.gateId === fixGate.gateId)?.state,
    "resolved",
  );
  assert.equal(
    atPub.snapshot.gates.find((g) => g.gateId === fixGate.gateId)?.decision?.decision,
    "pass",
  );
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "gate.fix")?.state, "succeeded");
  assert.ok(
    atPub.snapshot.nodes.find((n) => n.key === "validate.final")?.state === "succeeded",
    "validate.final should run after pass",
  );
});

test("resolve fix schedules repair.review.1 claimed with kind repair and feedback", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const repairClaims: Array<{
    key: string;
    kind: string;
    feedback?: string;
    hasWiki: boolean;
    hasDefects: boolean;
  }> = [];

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "repair") {
        repairClaims.push({
          key: input.node.key,
          kind: input.node.kind,
          feedback:
            typeof input.node.detail?.feedback === "string"
              ? input.node.detail.feedback
              : undefined,
          hasWiki: input.sealedInputs.some((item) => item.role === "wiki_tree"),
          hasDefects: input.sealedInputs.some((item) => item.role === "defects"),
        });
      }
      return blockingSeatExecutor()(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-repair" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-repair");
  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate);

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "fix-with-notes",
      runId: receipt.runId,
      gateId: fixGate.gateId,
      gateKind: "fix",
      payloadDigest: fixGate.payloadDigest,
      decision: "fix",
      feedback: "Add grounding citations to overview.md",
    },
    context(workspaceId),
  );

  // After fix, repair runs then validate.final → publication.
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "expected publication after repair.review",
  );

  assert.equal(repairClaims.length, 1, `expected one repair claim, got ${repairClaims.length}`);
  const claim = repairClaims[0]!;
  assert.equal(claim.kind, "repair");
  assert.equal(claim.key, `${REVIEW_REPAIR_NODE_PREFIX}1`);
  assert.equal(claim.feedback, "Add grounding citations to overview.md");
  assert.equal(claim.hasWiki, true, "repair.review must bind wiki_tree");
  assert.equal(claim.hasDefects, true, "repair.review must bind defects receipt");

  const repairNode = atPub.snapshot.nodes.find((n) => n.key === `${REVIEW_REPAIR_NODE_PREFIX}1`);
  assert.ok(repairNode);
  assert.equal(repairNode?.kind, "repair");
  assert.equal(repairNode?.state, "succeeded");
  // parentKey / claim bindings prove the review.reduce → repair edge path was live.
  assert.equal(claim.hasWiki, true);
  assert.equal(claim.hasDefects, true);
});

test("maxRepairRounds=0 rejects fix decision; pass still works", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: blockingSeatExecutor({ maxRepairRounds: 0 }),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-budget0" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-budget0");
  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate);

  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "resolve_gate",
          commandId: "fix-budget0",
          runId: receipt.runId,
          gateId: fixGate.gateId,
          gateKind: "fix",
          payloadDigest: fixGate.payloadDigest,
          decision: "fix",
        },
        context(workspaceId),
      ),
    /budget is 0|only pass or deny/i,
  );

  // Gate must remain open after rejected fix (transaction rolled back).
  const stillOpen = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(
    stillOpen.gates.find((g) => g.gateId === fixGate.gateId)?.state,
    "open",
  );

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "pass-budget0",
      runId: receipt.runId,
      gateId: fixGate.gateId,
      gateKind: "fix",
      payloadDigest: fixGate.payloadDigest,
      decision: "pass",
    },
    context(workspaceId),
  );
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"));
});

test("clean review auto-passes gate.fix (no HITL) and reaches publication", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: fullGraphFixtureExecutor,
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-clean" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-clean");
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "clean path should reach publication without fix HITL",
  );
  assert.equal(
    atPub.snapshot.gates.some((g) => g.kind === "fix" && g.state === "open"),
    false,
    "clean path must not leave an open fix gate",
  );
  assert.equal(atPub.snapshot.nodes.find((n) => n.key === "gate.fix")?.state, "succeeded");
});

test("resolve fix deny marks run failed", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: blockingSeatExecutor(),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-deny" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-deny");
  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate);

  await runs.dispatch(
    {
      type: "resolve_gate",
      commandId: "deny-fix",
      runId: receipt.runId,
      gateId: fixGate.gateId,
      gateKind: "fix",
      payloadDigest: fixGate.payloadDigest,
      decision: "deny",
    },
    context(workspaceId),
  );
  const after = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(after.state, "failed");
  assert.equal(after.gates.find((g) => g.gateId === fixGate.gateId)?.decision?.decision, "deny");
});
