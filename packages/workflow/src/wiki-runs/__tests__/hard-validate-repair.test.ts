/**
 * Durable auto mechanical repair after validate.pre/final schema failure (ADR 0038).
 * Schedules dedicated repair.N stages — does not disguise fix as write.root.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, test } from "node:test";
import type { PiAttemptInput, PiAttemptOutcome } from "@okf-wiki/contract/pi-attempt";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { openWikiRuns } from "../../wiki-runs.js";
import { baselineWikiForRepair, parseRepairRound, upstreamSealedOutputs } from "../attempt-inputs.js";
import {
  countRepairsBySource,
  isRepairNodeKey,
  MECHANICAL_REPAIR_FEEDBACK_PREFIX,
  REPAIR_NODE_PREFIX,
  repairNodeKey,
  shouldAutoMechanicalRepair,
} from "../repair-schedule.js";
import { partialControl } from "../testing/control-fixture.js";
import type { ClaimedNode } from "../types.js";
import {
  approvePlanGate,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  waitForRunState,
} from "./harness.js";

/** Unique markers to prove multi-round mechanical repair binds progressive wikis. */
const WRITE_ROOT_ONLY_MARKER = "WRITE_ROOT_ONLY_DIRTY_MARKER_9f3a";
const REPAIR_1_PROGRESS_MARKER = "REPAIR_1_PARTIAL_PROGRESS_MARKER_7c2b";

async function writeBadWiki(workDir: string): Promise<string> {
  const wikiDir = path.join(workDir, "wiki");
  await mkdir(wikiDir, { recursive: true });
  // Missing frontmatter type → validateWikiTree fails (schema / quality).
  await writeFile(
    path.join(wikiDir, "overview.md"),
    '---\ntitle: "Workflow test"\n---\n\n# Workflow test\n\nBroken fixture page.\n',
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, "index.md"),
    "---\ntype: Index\ntitle: Index\n---\n\n# Index\n\n- [Overview](./overview.md)\n",
    "utf8",
  );
  return wikiDir;
}

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

/** planWithHvBudget still sets maxHardValidateRepairRounds for mechanical budget. */
function planWithHvBudget(
  maxHardValidateRepairRounds: number,
): (input: PiAttemptInput, signal: AbortSignal) => Promise<PiAttemptOutcome> {
  return async (input, signal) => {
    if (input.node.kind === "plan") {
      const spec = defaultWikiRunSpec("Workflow test");
      spec.acceptance.maxHardValidateRepairRounds = maxHardValidateRepairRounds;
      const specPath = path.join(input.workDir, "spec.json");
      await mkdir(input.workDir, { recursive: true });
      await writeFile(specPath, `${JSON.stringify(spec)}\n`, "utf8");
      const transcript = path.join(input.attemptDir, "session.jsonl");
      await writeFile(
        transcript,
        [
          JSON.stringify({ role: "user", content: "Plan WikiRunSpec" }),
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

test("auto mechanical repair schedules repair.1 then reaches publication", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const writeClaims: Array<{ generation: number; feedback?: string }> = [];
  const repairClaims: Array<{
    key: string;
    kind: string;
    generation: number;
    feedback?: string;
    hasWiki: boolean;
  }> = [];

  const runs = await openWikiRuns({
    rootPath: root,
    // Explicit budget covers the multi-round mechanical repair path.
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") return planWithHvBudget(2)(input, signal);
      if (input.node.kind === "write.root") {
        const feedback =
          typeof input.node.detail?.feedback === "string" ? input.node.detail.feedback : undefined;
        writeClaims.push({ generation: input.node.generation, feedback });
        await mkdir(input.workDir, { recursive: true });
        // Initial write is dirty; repair stage fixes it.
        const wikiDir = await writeBadWiki(input.workDir);
        return writeSucceeded(input, wikiDir, "fixture write dirty");
      }
      if (input.node.kind === "repair") {
        const feedback =
          typeof input.node.detail?.feedback === "string" ? input.node.detail.feedback : undefined;
        repairClaims.push({
          key: input.node.key,
          kind: input.node.kind,
          generation: input.node.generation,
          feedback,
          hasWiki: input.sealedInputs.some((item) => item.role === "wiki_tree"),
        });
        await mkdir(input.workDir, { recursive: true });
        const wikiDir = await writeGoodWiki(input.workDir);
        return writeSucceeded(input, wikiDir, "fixture repair.1 fix");
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-mech-repair", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-mech-repair");

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "expected open publication gate after successful mechanical repair",
  );

  // write.root runs once at gen 0 with no mechanical feedback.
  assert.equal(
    writeClaims.length,
    1,
    `expected exactly one write.root claim, got ${writeClaims.length}`,
  );
  assert.equal(writeClaims[0]?.generation, 0);
  assert.equal(writeClaims[0]?.feedback, undefined);

  const writeNode = atPub.snapshot.nodes.find((n) => n.key === "write.root");
  assert.equal(writeNode?.state, "succeeded");
  assert.equal(writeNode?.generation, 0, "write.root generation stays 0 (not disguised as repair)");

  // Dedicated repair.1 stage carries feedback + prior wiki.
  assert.ok(
    repairClaims.length >= 1,
    `expected at least one repair claim, got ${repairClaims.length}`,
  );
  // Budget set to 2 via plan; a single pre-validate repair should suffice when
  // carry-forward prefers the repaired wiki over dirty write.root for review/final.
  assert.equal(
    repairClaims.length,
    1,
    `expected exactly one repair (not a second final-stage repair); got ${repairClaims
      .map((c) => c.key)
      .join(",")}`,
  );
  const repairClaim = repairClaims[0]!;
  assert.equal(repairClaim.kind, "repair");
  assert.equal(repairClaim.key, repairNodeKey(1));
  assert.equal(repairClaim.generation, 0);
  assert.ok(
    repairClaim.feedback?.startsWith(MECHANICAL_REPAIR_FEEDBACK_PREFIX),
    `feedback should start with mechanical prefix: ${repairClaim.feedback}`,
  );
  assert.match(repairClaim.feedback ?? "", /validation failed:/i);
  assert.equal(repairClaim.hasWiki, true, "repair.1 must bind prior wiki_tree from write.root");

  const repairNode = atPub.snapshot.nodes.find((n) => n.key === repairNodeKey(1));
  assert.ok(repairNode, "snapshot must include repair.1");
  assert.equal(repairNode?.kind, "repair");
  assert.equal(repairNode?.state, "succeeded");
  assert.equal(
    atPub.snapshot.nodes.some((n) => n.key === repairNodeKey(2)),
    false,
    "must not need repair.2 when repair.1 fixed the wiki",
  );

  const validateFailed = atPub.snapshot.attempts.filter(
    (a) => a.nodeKey === "validate.pre" && a.state === "failed",
  );
  assert.ok(validateFailed.length >= 1, "expected at least one failed validate.pre attempt");
  assert.equal(validateFailed[0]?.failureClass, "schema");
  assert.match(validateFailed[0]?.error ?? "", /validation failed:/i);

  const validateSucceeded = atPub.snapshot.attempts.filter(
    (a) => a.nodeKey === "validate.pre" && a.state === "succeeded",
  );
  assert.ok(validateSucceeded.length >= 1, "validate.pre must succeed after repair");

  // Durably counted on repair.* nodes with mechanical source.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const count = countRepairsBySource({ db }, receipt.runId, "mechanical");
  const edges = db
    .prepare(
      "SELECT from_key, to_key FROM node_edges WHERE run_id = ? AND (from_key = ? OR to_key = ?) ORDER BY from_key, to_key",
    )
    .all(receipt.runId, repairNodeKey(1), repairNodeKey(1)) as Array<{
    from_key: string;
    to_key: string;
  }>;
  db.close();
  assert.equal(count, 1, "exactly one auto mechanical repair node");
  assert.ok(
    edges.some((e) => e.from_key === "write.root" && e.to_key === repairNodeKey(1)),
    "edge write.root → repair.1",
  );
  assert.ok(
    edges.some((e) => e.from_key === repairNodeKey(1) && e.to_key === "validate.pre"),
    "edge repair.1 → validate.pre",
  );
});

test("mechanical budget exhaustion exposes one executable operator continuation", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let writeCount = 0;
  let repairCount = 0;
  const base = planWithHvBudget(1);

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") return base(input, signal);
      if (input.node.kind === "write.root") {
        writeCount += 1;
        await mkdir(input.workDir, { recursive: true });
        const wikiDir = await writeBadWiki(input.workDir);
        return writeSucceeded(input, wikiDir, `fixture write dirty #${writeCount}`);
      }
      if (input.node.kind === "repair") {
        repairCount += 1;
        await mkdir(input.workDir, { recursive: true });
        // Always dirty so repair cannot clear validation.
        const wikiDir = await writeBadWiki(input.workDir);
        return writeSucceeded(input, wikiDir, `fixture repair dirty #${repairCount}`);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-mech-exhaust", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-mech-exhaust");

  const failed = await waitForRunState(runs, receipt.runId, ["failed"], 60_000);
  assert.equal(failed.snapshot.state, "failed");
  // Initial write once + one auto repair stage (budget=1); no infinite loop.
  assert.equal(writeCount, 1, `expected exactly 1 write.root, got ${writeCount}`);
  assert.equal(repairCount, 1, `expected exactly 1 repair.N (budget 1), got ${repairCount}`);

  const writeNode = failed.snapshot.nodes.find((n) => n.key === "write.root");
  assert.equal(writeNode?.generation, 0, "write.root must not be bumped for mechanical repair");

  const repairNode = failed.snapshot.nodes.find((n) => n.key === repairNodeKey(1));
  assert.ok(repairNode, "repair.1 must exist after budget exhaust path");
  assert.equal(repairNode?.kind, "repair");

  const validateFailed = failed.snapshot.attempts.filter(
    (a) => a.nodeKey === "validate.pre" && a.state === "failed",
  );
  assert.ok(
    validateFailed.length >= 2,
    `expected ≥2 failed validates after budget exhaust, got ${validateFailed.length}`,
  );

  const recovery = failed.snapshot.evaluationRecoveries?.[0];
  assert.ok(recovery, "default operator policy must expose recovery after budget exhaustion");
  assert.equal(recovery.source, "mechanical");
  assert.ok(recovery.reportArtifactId, "recovery must preserve sealed validation evidence");
  const candidateId = recovery.candidateId;

  await runs.dispatch(
    {
      type: "continue_evaluation",
      commandId: "continue-mech-exhaust",
      runId: receipt.runId,
      expectedRevision: (await runs.read({ runId: receipt.runId })).snapshot.revision,
      recoveryId: recovery.recoveryId,
    },
    context(workspaceId),
  );

  const afterContinuation = await waitForRunState(runs, receipt.runId, ["failed"], 60_000);
  assert.equal(repairCount, 2, "one explicit continuation schedules exactly one additional repair");
  assert.equal(
    afterContinuation.snapshot.evaluationRecoveries,
    undefined,
    "a consumed continuation cannot create another recovery",
  );
  const latestCandidate = afterContinuation.snapshot.candidates.at(-1);
  assert.ok(latestCandidate);
  assert.notEqual(
    latestCandidate.candidateId,
    candidateId,
    "continuation must advance candidate lineage",
  );
  const exhaustedRevision = (await runs.read({ runId: receipt.runId })).snapshot.revision;
  await assert.rejects(
    () =>
      runs.dispatch(
        {
          type: "continue_evaluation",
          commandId: "continue-mech-exhaust-again",
          runId: receipt.runId,
          expectedRevision: exhaustedRevision,
          recoveryId: recovery.recoveryId,
        },
        context(workspaceId),
      ),
    /stale or unavailable/i,
  );
});

test("multi-round repair.2 binds wiki from repair.1 not write.root", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const repairClaims: Array<{
    key: string;
    wikiPath?: string;
    wikiBody?: string;
  }> = [];
  const base = planWithHvBudget(2);

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") return base(input, signal);
      if (input.node.kind === "write.root") {
        await mkdir(input.workDir, { recursive: true });
        // Dirty wiki with a unique marker that must NOT be the sole seed for round 2.
        const wikiDir = path.join(input.workDir, "wiki");
        await mkdir(wikiDir, { recursive: true });
        await writeFile(
          path.join(wikiDir, "overview.md"),
          [
            "---",
            'title: "Workflow test"',
            "---",
            "",
            "# Workflow test",
            "",
            WRITE_ROOT_ONLY_MARKER,
            "",
          ].join("\n"),
          "utf8",
        );
        await writeFile(
          path.join(wikiDir, "index.md"),
          "---\ntype: Index\ntitle: Index\n---\n\n# Index\n\n- [Overview](./overview.md)\n",
          "utf8",
        );
        return writeSucceeded(input, wikiDir, "fixture write dirty with marker");
      }
      if (input.node.kind === "repair") {
        const wikiInput = input.sealedInputs.find((item) => item.role === "wiki_tree");
        let wikiBody: string | undefined;
        if (wikiInput?.readOnlyPath) {
          try {
            wikiBody = await readFile(path.join(wikiInput.readOnlyPath, "overview.md"), "utf8");
          } catch {
            wikiBody = undefined;
          }
        }
        repairClaims.push({
          key: input.node.key,
          wikiPath: wikiInput?.readOnlyPath,
          wikiBody,
        });
        await mkdir(input.workDir, { recursive: true });
        if (input.node.key === repairNodeKey(1)) {
          // Partial fix: still fails validate (missing type) but carries unique progress.
          const wikiDir = path.join(input.workDir, "wiki");
          await mkdir(wikiDir, { recursive: true });
          await writeFile(
            path.join(wikiDir, "overview.md"),
            [
              "---",
              'title: "Workflow test"',
              "---",
              "",
              "# Workflow test",
              "",
              REPAIR_1_PROGRESS_MARKER,
              "",
              "Partial repair.1 fix — still missing type frontmatter.",
              "",
            ].join("\n"),
            "utf8",
          );
          await writeFile(
            path.join(wikiDir, "index.md"),
            "---\ntype: Index\ntitle: Index\n---\n\n# Index\n\n- [Overview](./overview.md)\n",
            "utf8",
          );
          return writeSucceeded(input, wikiDir, "fixture repair.1 partial");
        }
        // repair.2: emit a fully valid wiki so the run can complete.
        const wikiDir = await writeGoodWiki(input.workDir);
        return writeSucceeded(input, wikiDir, "fixture repair.2 full fix");
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-mech-multi", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-mech-multi");

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "expected open publication gate after multi-round mechanical repair",
  );

  assert.equal(
    repairClaims.length,
    2,
    `expected repair.1 then repair.2, got ${repairClaims.map((c) => c.key).join(",")}`,
  );
  assert.equal(repairClaims[0]?.key, repairNodeKey(1));
  assert.equal(repairClaims[1]?.key, repairNodeKey(2));

  // Round 1 seeds from dirty write.root.
  assert.ok(
    repairClaims[0]?.wikiBody?.includes(WRITE_ROOT_ONLY_MARKER),
    "repair.1 must bind write.root dirty wiki",
  );

  // Round 2 must bind progressive wiki from repair.1 — not discard progress for write.root.
  const round2Body = repairClaims[1]?.wikiBody ?? "";
  assert.ok(
    round2Body.includes(REPAIR_1_PROGRESS_MARKER),
    `repair.2 must bind repair.1 wiki containing ${REPAIR_1_PROGRESS_MARKER}; got: ${round2Body.slice(0, 200)}`,
  );
  assert.equal(
    round2Body.includes(WRITE_ROOT_ONLY_MARKER),
    false,
    "repair.2 must not re-bind write.root-only dirty content (progress discarded)",
  );

  assert.ok(
    atPub.snapshot.nodes.some((n) => n.key === repairNodeKey(2) && n.state === "succeeded"),
    "repair.2 must succeed",
  );
});

test("maxHardValidateRepairRounds=0 never auto-repairs", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let writeCount = 0;
  let repairCount = 0;
  const base = planWithHvBudget(0);

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") return base(input, signal);
      if (input.node.kind === "write.root") {
        writeCount += 1;
        await mkdir(input.workDir, { recursive: true });
        const wikiDir = await writeBadWiki(input.workDir);
        return writeSucceeded(input, wikiDir, "fixture write dirty");
      }
      if (input.node.kind === "repair") {
        repairCount += 1;
        return fullGraphFixtureExecutor(input, signal);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-mech-zero", intent: { mode: "generate" } },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-mech-zero");

  const failed = await waitForRunState(runs, receipt.runId, ["failed"], 60_000);
  assert.equal(failed.snapshot.state, "failed");
  assert.equal(writeCount, 1, "budget 0 must not re-run write.root");
  assert.equal(repairCount, 0, "budget 0 must not schedule repair.N");
  const validateFailed = failed.snapshot.attempts.find(
    (a) => a.nodeKey === "validate.pre" && a.state === "failed",
  );
  assert.ok(validateFailed);
  assert.equal(validateFailed?.failureClass, "schema");
  assert.equal(
    failed.snapshot.nodes.some((n) => isRepairNodeKey(n.key)),
    false,
  );
});

describe("shouldAutoMechanicalRepair (unit)", () => {
  function openPolicyDb(opts: {
    cancelRequested?: boolean;
    writeRoot?: boolean;
    /** Dedicated repair.N node keys already present. */
    repairKeys?: string[];
    /** When set, seal a plan/spec row pointing at this relative path under run work dir. */
    specRelativePath?: string;
    /**
     * Fake wiki_candidates rows for the run (creates table when set).
     * Used to exercise EvaluationPolicy.maxCandidates without the candidate module.
     */
    wikiCandidateCount?: number;
  }): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        cancel_requested INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE nodes (
        run_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        detail_json TEXT
      ) STRICT;
      CREATE TABLE node_outputs (
        run_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        node_generation INTEGER NOT NULL,
        role TEXT NOT NULL,
        artifact_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL
      ) STRICT;
    `);
    db.prepare("INSERT INTO runs (run_id, cancel_requested) VALUES (?, ?)").run(
      "run-1",
      opts.cancelRequested ? 1 : 0,
    );
    if (opts.writeRoot !== false) {
      db.prepare(
        "INSERT INTO nodes (run_id, node_key, generation, detail_json) VALUES ('run-1', 'write.root', 0, NULL)",
      ).run();
    }
    if (opts.specRelativePath) {
      db.prepare("INSERT INTO artifacts (artifact_id, relative_path) VALUES ('spec-art', ?)").run(
        opts.specRelativePath,
      );
      db.prepare(
        `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
         VALUES ('run-1', 'plan', 0, 'spec', 'spec-art')`,
      ).run();
    }
    for (const key of opts.repairKeys ?? []) {
      db.prepare(
        "INSERT INTO nodes (run_id, node_key, generation, detail_json) VALUES ('run-1', ?, 0, ?)",
      ).run(
        key,
        JSON.stringify({
          autoRepair: true,
          feedback: `${MECHANICAL_REPAIR_FEEDBACK_PREFIX}round):\nok`,
          source: "mechanical",
          repairRequest: {
            requestId: `repair:mechanical:run-1:${key}`,
            baselineCandidateId: "pending",
            round: 1,
            sources: ["mechanical"],
            issues: [],
            scope: { pages: [], mode: "patch" },
          },
        }),
      );
    }
    if (opts.wikiCandidateCount !== undefined) {
      db.exec(`
        CREATE TABLE wiki_candidates (
          run_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          produced_by TEXT NOT NULL
        ) STRICT;
      `);
      const insert = db.prepare(
        "INSERT INTO wiki_candidates (run_id, candidate_id, produced_by) VALUES ('run-1', ?, 'write')",
      );
      for (let i = 0; i < opts.wikiCandidateCount; i += 1) {
        insert.run(`cand-${i + 1}`);
      }
    }
    return db;
  }

  function host(opts: {
    closed?: boolean;
    cancelRequested?: boolean;
    writeRoot?: boolean;
    repairKeys?: string[];
    rootPath?: string;
    specRelativePath?: string;
    wikiCandidateCount?: number;
  }) {
    return partialControl({
      workspace: {
        rootPath: opts.rootPath ?? "/tmp/okf-mech-unit-missing",
        limits: { retry: { enabled: true } },
      } as WorkspaceConfig,
      db: openPolicyDb(opts),
      closed: opts.closed ?? false,
      // Unused by shouldAutoMechanicalRepair policy checks.
      emit: () => 0,
      currentNodeGeneration: () => undefined,
      applyRerunAt: () => undefined,
    });
  }

  const validateClaim: ClaimedNode = {
    attemptId: "attempt-v",
    nodeGeneration: 0,
    nodeKey: "validate.pre",
    kind: "validate.pre",
    runId: "run-1",
  };

  it("allows one auto mechanical repair by default when no sealed Spec overrides it", () => {
    // Product default: one model repair gives normal runs a bounded self-heal path.
    assert.equal(
      shouldAutoMechanicalRepair(
        host({}),
        validateClaim,
        "validation failed: overview.md: missing type",
        "schema",
      ),
      true,
    );
  });

  it("allows validate.pre schema failure when sealed Spec grants mechanical budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-mech-budget-"));
    const rel = "artifacts/spec-budget";
    // runWorkDir(root, runId) = {root}/.okf-wiki/runs/{runId}
    const runDir = path.join(root, ".okf-wiki", "runs", "run-1");
    await mkdir(path.join(runDir, rel), { recursive: true });
    const spec = defaultWikiRunSpec("mechanical budget unit");
    spec.acceptance = {
      ...spec.acceptance,
      maxHardValidateRepairRounds: 2,
    };
    await writeFile(path.join(runDir, rel, "spec.json"), `${JSON.stringify(spec)}\n`, "utf8");

    assert.equal(
      shouldAutoMechanicalRepair(
        host({ rootPath: root, specRelativePath: rel }),
        validateClaim,
        "validation failed: overview.md: missing type",
        "schema",
      ),
      true,
    );
    await rm(root, { recursive: true, force: true });
  });

  it("denies when maxCandidates would be exceeded even with mechanical budget remaining", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "okf-mech-maxcand-"));
    const rel = "artifacts/spec-maxcand";
    const runDir = path.join(root, ".okf-wiki", "runs", "run-1");
    await mkdir(path.join(runDir, rel), { recursive: true });
    const spec = defaultWikiRunSpec("mechanical maxCandidates unit");
    // Mechanical budget remaining (2), but candidate ceiling is 3 and table is full.
    spec.acceptance = {
      ...spec.acceptance,
      maxHardValidateRepairRounds: 2,
      maxCandidates: 3,
    };
    await writeFile(path.join(runDir, rel, "spec.json"), `${JSON.stringify(spec)}\n`, "utf8");

    assert.equal(
      shouldAutoMechanicalRepair(
        host({
          rootPath: root,
          specRelativePath: rel,
          wikiCandidateCount: 3,
        }),
        validateClaim,
        "validation failed: overview.md: missing type",
        "schema",
      ),
      false,
      "maxCandidates must block auto mechanical even when modelRepairBudget remains",
    );
    // Under ceiling still allows when budget remains.
    assert.equal(
      shouldAutoMechanicalRepair(
        host({
          rootPath: root,
          specRelativePath: rel,
          wikiCandidateCount: 2,
        }),
        validateClaim,
        "validation failed: overview.md: missing type",
        "schema",
      ),
      true,
    );
    await rm(root, { recursive: true, force: true });
  });

  it("denies infrastructure and non-validate kinds", () => {
    assert.equal(
      shouldAutoMechanicalRepair(
        host({}),
        validateClaim,
        "validate requires sealed wiki_tree input",
        "infrastructure",
      ),
      false,
    );
    assert.equal(
      shouldAutoMechanicalRepair(
        host({}),
        { ...validateClaim, kind: "write.root", nodeKey: "write.root" },
        "validation failed: x",
        "schema",
      ),
      false,
    );
  });

  it("denies when budget exhausted by prior repair.N nodes", () => {
    // Default mechanical budget is 0 — any prior repair exhausts or blocks auto mechanical.
    assert.equal(
      shouldAutoMechanicalRepair(
        host({
          repairKeys: [repairNodeKey(1), repairNodeKey(2)],
        }),
        validateClaim,
        "validation failed: z",
        "schema",
      ),
      false,
    );
  });

  it("counts mechanical repair.N nodes by source", () => {
    const db = openPolicyDb({
      repairKeys: [repairNodeKey(1), repairNodeKey(2)],
    });
    assert.equal(countRepairsBySource({ db }, "run-1", "mechanical"), 2);
    assert.equal(countRepairsBySource({ db }, "run-1", "semantic"), 0);
  });

  it("counts only the current generation when a repair node is rerun", () => {
    const db = openPolicyDb({ repairKeys: [repairNodeKey(1)] });
    db.prepare(
      "INSERT INTO nodes (run_id, node_key, generation, detail_json) VALUES ('run-1', ?, 1, ?)",
    ).run(
      repairNodeKey(1),
      JSON.stringify({
        repairRequest: {
          requestId: "repair:run-1:1",
          baselineCandidateId: "pending",
          round: 1,
          sources: ["mechanical"],
          issues: [{ kind: "mechanical", message: "retry" }],
          scope: { pages: [], mode: "patch" },
        },
      }),
    );
    assert.equal(countRepairsBySource({ db }, "run-1", "mechanical"), 1);
  });
});

describe("baselineWikiForRepair / upstreamSealedOutputs (unit)", () => {
  function openBindingDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE nodes (
        run_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        kind TEXT,
        detail_json TEXT
      ) STRICT;
      CREATE TABLE node_outputs (
        run_id TEXT NOT NULL,
        node_key TEXT NOT NULL,
        node_generation INTEGER NOT NULL,
        role TEXT NOT NULL,
        artifact_id TEXT NOT NULL
      ) STRICT;
      CREATE TABLE node_edges (
        run_id TEXT NOT NULL,
        from_key TEXT NOT NULL,
        to_key TEXT NOT NULL,
        PRIMARY KEY (run_id, from_key, to_key)
      ) STRICT;
      CREATE TABLE artifacts (
        run_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (run_id, artifact_id)
      ) STRICT;
      CREATE TABLE wiki_candidates (
        run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        parent_candidate_id TEXT,
        produced_by TEXT NOT NULL,
        round INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        producer_node_key TEXT,
        producer_attempt_id TEXT,
        PRIMARY KEY (run_id, candidate_id)
      ) STRICT;
    `);
    return db;
  }

  function seedSucceededWiki(
    db: DatabaseSync,
    nodeKey: string,
    artifactId: string,
    generation = 0,
  ): void {
    db.prepare(
      `INSERT INTO nodes (run_id, node_key, generation, state, kind)
       VALUES ('run-1', ?, ?, 'succeeded', 'repair')`,
    ).run(nodeKey, generation);
    db.prepare(
      `INSERT INTO node_outputs (run_id, node_key, node_generation, role, artifact_id)
       VALUES ('run-1', ?, ?, 'wiki_tree', ?)`,
    ).run(nodeKey, generation, artifactId);
  }

  function seedCandidate(
    db: DatabaseSync,
    candidateId: string,
    artifactId: string,
    round: number,
  ): void {
    db.prepare(
      `INSERT INTO artifacts (run_id, artifact_id, kind)
       VALUES ('run-1', ?, 'wiki_tree')`,
    ).run(artifactId);
    db.prepare(
      `INSERT INTO wiki_candidates (
        run_id, candidate_id, digest, artifact_id, parent_candidate_id,
        produced_by, round, created_at, producer_node_key, producer_attempt_id
      ) VALUES ('run-1', ?, ?, ?, NULL, 'repair', ?, '2026-08-01T00:00:00.000Z', NULL, NULL)`,
    ).run(candidateId, `digest-${candidateId}`, artifactId, round);
  }

  function seedRepair(db: DatabaseSync, nodeKey: string, baselineCandidateId: string): void {
    db.prepare(
      `INSERT INTO nodes (run_id, node_key, generation, state, kind, detail_json)
       VALUES ('run-1', ?, 0, 'ready', 'repair', ?)`,
    ).run(
      nodeKey,
      JSON.stringify({
        repairRequest: {
          requestId: `repair:mechanical:run-1:${nodeKey}`,
          baselineCandidateId,
          round: parseRepairRound(nodeKey),
          sources: ["mechanical"],
          issues: [{ kind: "mechanical", message: "repair fixture" }],
          scope: { pages: [], mode: "patch" },
        },
      }),
    );
  }

  function host(db: DatabaseSync) {
    return {
      db,
      currentNodeGeneration(runId: string, nodeKey: string): number | undefined {
        const row = db
          .prepare(
            `SELECT MAX(generation) AS generation FROM nodes
             WHERE run_id = ? AND node_key = ?`,
          )
          .get(runId, nodeKey) as { generation: number | null } | undefined;
        if (!row || row.generation === null || row.generation === undefined) return undefined;
        return row.generation;
      },
    };
  }

  it("parseRepairRound extracts N from repair.N only", () => {
    assert.equal(parseRepairRound(repairNodeKey(1)), 1);
    assert.equal(parseRepairRound(repairNodeKey(12)), 12);
    assert.equal(parseRepairRound("repair.hv.1"), undefined);
    assert.equal(parseRepairRound("repair.review.1"), undefined);
    assert.equal(parseRepairRound("write.root"), undefined);
    assert.equal(isRepairNodeKey(repairNodeKey(1)), true);
    assert.equal(isRepairNodeKey("repair.hv.1"), false);
    assert.equal(REPAIR_NODE_PREFIX, "repair.");
  });

  it("baseline uses the persisted candidate even when a newer candidate exists", () => {
    const db = openBindingDb();
    seedCandidate(db, "candidate-a", "art-a", 1);
    seedCandidate(db, "candidate-b", "art-b-newer", 2);
    seedRepair(db, repairNodeKey(1), "candidate-a");

    const h = host(db);
    const round1 = baselineWikiForRepair(h, "run-1", repairNodeKey(1));
    assert.equal(round1?.artifactId, "art-a");
  });

  it("upstreamSealedOutputs for repair uses its declared candidate over a newer tree", () => {
    const db = openBindingDb();
    seedSucceededWiki(db, "write.root", "art-write", 0);
    db.prepare("UPDATE nodes SET kind = 'write.root' WHERE node_key = 'write.root'").run();
    seedSucceededWiki(db, repairNodeKey(1), "art-r1", 0);
    seedCandidate(db, "candidate-r1", "art-r1", 1);
    seedCandidate(db, "candidate-newer", "art-newer", 2);
    seedRepair(db, repairNodeKey(2), "candidate-r1");
    db.prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES ('run-1', 'write.root', ?)`,
    ).run(repairNodeKey(2));

    const bound = upstreamSealedOutputs(host(db), "run-1", repairNodeKey(2));
    const wiki = bound.find((item) => item.role === "wiki_tree");
    assert.equal(
      wiki?.artifactId,
      "art-r1",
      "must use the declared candidate, not the newest tree",
    );
  });

  it("repair binding fails closed when its declared baseline is unavailable", () => {
    const db = openBindingDb();
    seedSucceededWiki(db, "write.root", "art-write", 0);
    db.prepare("UPDATE nodes SET kind = 'write.root' WHERE node_key = 'write.root'").run();
    seedRepair(db, repairNodeKey(1), "candidate-missing");
    db.prepare(
      `INSERT INTO node_edges (run_id, from_key, to_key) VALUES ('run-1', 'write.root', ?)`,
    ).run(repairNodeKey(1));

    assert.throws(
      () => upstreamSealedOutputs(host(db), "run-1", repairNodeKey(1)),
      /references unavailable baseline candidate candidate-missing/,
    );
  });

  it("repair binding fails closed when its candidate no longer references a sealed wiki tree", () => {
    const db = openBindingDb();
    seedCandidate(db, "candidate-invalid", "art-invalid", 1);
    db.prepare("UPDATE artifacts SET kind = 'receipt' WHERE artifact_id = 'art-invalid'").run();
    seedRepair(db, repairNodeKey(1), "candidate-invalid");

    assert.throws(
      () => upstreamSealedOutputs(host(db), "run-1", repairNodeKey(1)),
      /does not reference a sealed wiki_tree/,
    );
  });

  it("upstreamSealedOutputs for validate.pre prefers highest-N repair wiki", () => {
    const db = openBindingDb();
    seedSucceededWiki(db, "write.root", "art-write", 0);
    db.prepare("UPDATE nodes SET kind = 'write.root' WHERE node_key = 'write.root'").run();
    seedSucceededWiki(db, repairNodeKey(1), "art-r1", 0);
    seedSucceededWiki(db, repairNodeKey(2), "art-r2", 0);
    for (const from of ["write.root", repairNodeKey(1), repairNodeKey(2)]) {
      db.prepare(
        `INSERT INTO node_edges (run_id, from_key, to_key) VALUES ('run-1', ?, 'validate.pre')`,
      ).run(from);
    }
    db.prepare(
      `INSERT INTO nodes (run_id, node_key, generation, state, kind)
       VALUES ('run-1', 'validate.pre', 1, 'ready', 'validate.pre')`,
    ).run();

    const bound = upstreamSealedOutputs(host(db), "run-1", "validate.pre");
    const wiki = bound.find((item) => item.role === "wiki_tree");
    assert.equal(wiki?.artifactId, "art-r2", "validate must prefer repair.2 over .1 / write.root");
  });
});
