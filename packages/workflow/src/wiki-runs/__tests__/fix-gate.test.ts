/**
 * Phase F1: gate.fix after review.reduce + repair.N on ResolveGate(fix) (ADR 0038).
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { defaultWikiRunSpec, type PiAttemptInput, type PiAttemptOutcome } from "@okf-wiki/contract";
import { openWikiRuns } from "../../wiki-runs.js";
import { repairNodeKey } from "../repair-schedule.js";
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
function blockingSeatExecutor(options?: {
  maxRepairRounds?: number;
  onExhausted?: "fail" | "operator";
}): (input: PiAttemptInput, signal: AbortSignal) => Promise<PiAttemptOutcome> {
  let blockingEmitted = false;
  return async (input, signal) => {
    if (input.node.kind === "plan") {
      const spec = defaultWikiRunSpec("Workflow test");
      if (options?.maxRepairRounds !== undefined) {
        spec.acceptance.maxRepairRounds = options.maxRepairRounds;
      }
      if (options?.onExhausted !== undefined) {
        spec.acceptance.evaluationPolicy = { onExhausted: options.onExhausted };
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
      const reviewerId = input.node.key.replace(/^review\.seat\./, "") || "general";
      // First seat only: emit one blocking defect so reduce seals dirty report.
      // After repair re-seats, emit clean so EvaluationRound can auto-pass.
      const isReReview = input.node.generation > 0;
      const blocking = !isReReview && !blockingEmitted;
      if (blocking) blockingEmitted = true;
      const body = blocking
        ? {
            version: 1 as const,
            reviewerId,
            clean: false,
            defects: [
              {
                severity: "blocking" as const,
                code: "missing_citation",
                issue: "overview lacks grounding citations",
                path: "overview.md",
                reviewerId,
              },
            ],
            summary: "blocking: missing citation",
          }
        : {
            version: 1 as const,
            reviewerId,
            clean: true,
            defects: [] as const,
            summary: "NO_DEFECTS",
          };
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
      return writeSucceeded(input, wikiDir, "fixture repair.1 fix");
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
    { type: "start_run", commandId: "start-def-fix", intent: { mode: "generate" } },
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
    { type: "start_run", commandId: "start-fix-open", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-open");

  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate, "expected open fix gate after blocking review.reduce");
  assert.equal(fixGate.nodeKey, "gate.fix");
  assert.equal(atFix.snapshot.nodes.find((n) => n.key === "gate.fix")?.state, "waiting");

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
    { type: "start_run", commandId: "start-fix-pass", intent: { mode: "generate" } },
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
  assert.equal(atPub.snapshot.gates.find((g) => g.gateId === fixGate.gateId)?.state, "resolved");
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

test("resolve fix schedules repair.1 claimed with kind repair and feedback", async (t) => {
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
    { type: "start_run", commandId: "start-fix-repair", intent: { mode: "generate" } },
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

  // After fix: repair → validate.pre → re-seats → reduce → gate → validate.final → publication.
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 90_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "expected publication after repair.1 EvaluationRound",
  );

  assert.equal(repairClaims.length, 1, `expected one repair claim, got ${repairClaims.length}`);
  const claim = repairClaims[0]!;
  assert.equal(claim.kind, "repair");
  assert.equal(claim.key, repairNodeKey(1));
  assert.equal(claim.feedback, "Add grounding citations to overview.md");
  assert.equal(claim.hasWiki, true, "repair.1 must bind wiki_tree");
  assert.equal(claim.hasDefects, true, "repair.1 must bind defects receipt");

  const repairNode = atPub.snapshot.nodes.find((n) => n.key === repairNodeKey(1));
  assert.ok(repairNode);
  assert.equal(repairNode?.kind, "repair");
  assert.equal(repairNode?.state, "succeeded");

  // EvaluationRound: seats re-ran after repair (generation > 0 on at least one seat).
  const reSeated = atPub.snapshot.nodes.filter(
    (n) => n.kind === "review.seat" && n.generation > 0 && n.state === "succeeded",
  );
  assert.ok(reSeated.length >= 1, "expected review seats re-armed after repair.1");
  const reduceAfter = atPub.snapshot.nodes.find((n) => n.key === "review.reduce");
  assert.ok(
    reduceAfter && reduceAfter.generation > 0 && reduceAfter.state === "succeeded",
    "review.reduce must re-run after repair (not repair→validate.final bypass)",
  );

  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const edges = db
    .prepare(
      "SELECT from_key, to_key FROM node_edges WHERE run_id = ? AND (from_key = ? OR to_key = ?) ORDER BY from_key, to_key",
    )
    .all(receipt.runId, repairNodeKey(1), repairNodeKey(1)) as Array<{
    from_key: string;
    to_key: string;
  }>;
  db.close();
  assert.ok(
    edges.some((e) => e.from_key === "review.reduce" && e.to_key === repairNodeKey(1)),
    "edge review.reduce → repair.1",
  );
  assert.ok(
    edges.some((e) => e.from_key === repairNodeKey(1) && e.to_key === "validate.pre"),
    "edge repair.1 → validate.pre (EvaluationRound, not validate.final bypass)",
  );
  assert.equal(
    edges.some((e) => e.from_key === repairNodeKey(1) && e.to_key === "validate.final"),
    false,
    "must not wire repair → validate.final bypass",
  );
});

test("semantic budget exhaustion opens one operator recovery and continues through repair", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: blockingSeatExecutor({ maxRepairRounds: 0 }),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-budget0", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-budget0");
  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate);

  await runs.dispatch(
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
  );

  const failed = await waitForRunState(runs, receipt.runId, ["failed"], 60_000);
  const recovery = failed.snapshot.evaluationRecoveries?.[0];
  assert.ok(recovery, "semantic exhaustion must expose a durable recovery");
  assert.equal(recovery.source, "semantic");
  assert.ok(recovery.reportArtifactId, "recovery must bind the sealed defects report");

  await runs.dispatch(
    {
      type: "continue_evaluation",
      commandId: "continue-semantic-budget0",
      runId: receipt.runId,
      recoveryId: recovery.recoveryId,
    },
    context(workspaceId),
  );
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"));
});

test("semantic budget exhaustion fails explicitly when policy is fail", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: blockingSeatExecutor({ maxRepairRounds: 0, onExhausted: "fail" }),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-fix-budget0-fail", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-fix-budget0-fail");
  const atFix = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  const fixGate = atFix.snapshot.gates.find((g) => g.kind === "fix" && g.state === "open");
  assert.ok(fixGate);

  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "resolve_gate",
          commandId: "fix-budget0-fail",
          runId: receipt.runId,
          gateId: fixGate.gateId,
          gateKind: "fix",
          payloadDigest: fixGate.payloadDigest,
          decision: "fix",
        },
        context(workspaceId),
      ),
    /budget exhausted/i,
  );
  const stillOpen = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(stillOpen.gates.find((g) => g.gateId === fixGate.gateId)?.state, "open");
  assert.equal(stillOpen.evaluationRecoveries, undefined);
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
    { type: "start_run", commandId: "start-fix-clean", intent: { mode: "generate" } },
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

/**
 * Plan with acceptance.reviewRequired=false → zero review.seat nodes →
 * review.reduce claims without review_seat artifacts and seals clean NO_DEFECTS.
 * Regression: NodeContract used to require review_seat and stuck the claim.
 */
function noReviewRequiredExecutor(): (
  input: PiAttemptInput,
  signal: AbortSignal,
) => Promise<PiAttemptOutcome> {
  return async (input, signal) => {
    if (input.node.kind === "plan") {
      const spec = defaultWikiRunSpec("Workflow test");
      spec.acceptance.reviewRequired = false;
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
    return fullGraphFixtureExecutor(input, signal);
  };
}

test("reviewRequired=false: zero seats, review.reduce succeeds clean past claim", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));
  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: noReviewRequiredExecutor(),
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-no-review", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-no-review");

  // After approve: graph must have no seats (compile skips them when reviewRequired=false).
  const afterApprove = (await runs.read({ runId: receipt.runId })).snapshot;
  assert.equal(
    afterApprove.nodes.some((n) => n.kind === "review.seat"),
    false,
    "reviewRequired=false must materialize zero review.seat nodes",
  );
  assert.ok(
    afterApprove.nodes.some((n) => n.key === "review.reduce"),
    "review.reduce still present for mechanical clean path",
  );

  // Path must reach publication without stuck claim on reduce (no review_seat bound).
  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "zero-seat clean path should reach publication",
  );

  const reduce = atPub.snapshot.nodes.find((n) => n.key === "review.reduce");
  assert.equal(reduce?.state, "succeeded", "review.reduce must succeed with zero seats");
  const reduceAttempt = atPub.snapshot.attempts.find(
    (a) => a.nodeKey === "review.reduce" && a.state === "succeeded",
  );
  assert.ok(reduceAttempt, "review.reduce attempt must succeed (not stuck on claim)");
  assert.ok(
    reduce?.outputs.some((o) => o.role === "defects"),
    "zero-seat path must seal clean defects receipt",
  );
  assert.equal(
    atPub.snapshot.gates.some((g) => g.kind === "fix" && g.state === "open"),
    false,
    "clean zero-seat path must auto-pass gate.fix",
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
    { type: "start_run", commandId: "start-fix-deny", intent: { mode: "generate" } },
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
