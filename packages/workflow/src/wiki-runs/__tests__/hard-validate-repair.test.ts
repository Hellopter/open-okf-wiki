/**
 * Durable auto hard-validate repair after validate.pre/final schema failure.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, test } from "node:test";
import {
  defaultWikiRunSpec,
  type PiAttemptInput,
  type PiAttemptOutcome,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import { openWikiRuns } from "../../wiki-runs.js";
import {
  countAutoHardValidateRepairs,
  HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX,
  type SchedulerHost,
  shouldAutoHardValidateRepair,
} from "../scheduler.js";
import type { ClaimedNode } from "../types.js";
import {
  approvePlanGate,
  context,
  fullGraphFixtureExecutor,
  makeWorkspace,
  removeWorkspace,
  succeededPlan,
  waitForRunState,
} from "./harness.js";

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

test("auto hard-validate repair re-runs write.root with feedback then reaches publication", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  const writeClaims: Array<{ generation: number; feedback?: string; hasWiki: boolean }> = [];

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") return succeededPlan(input);
      if (input.node.kind === "write.root") {
        const feedback =
          typeof input.node.detail?.feedback === "string"
            ? input.node.detail.feedback
            : undefined;
        writeClaims.push({
          generation: input.node.generation,
          feedback,
          hasWiki: input.sealedInputs.some((item) => item.role === "wiki_tree"),
        });
        await mkdir(input.workDir, { recursive: true });
        if (!feedback) {
          const wikiDir = await writeBadWiki(input.workDir);
          return writeSucceeded(input, wikiDir, "fixture write dirty");
        }
        // Repair round: fix validation defects.
        const wikiDir = await writeGoodWiki(input.workDir);
        return writeSucceeded(input, wikiDir, "fixture write repair");
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-hv-repair" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-hv-repair");

  const atPub = await waitForRunState(runs, receipt.runId, ["waiting_for_operator"], 60_000);
  assert.ok(
    atPub.snapshot.gates.some((g) => g.kind === "publication" && g.state === "open"),
    "expected open publication gate after successful HV repair",
  );

  assert.ok(writeClaims.length >= 2, `expected write + repair, got ${writeClaims.length}`);
  const repairClaim = writeClaims.find((c) => c.feedback);
  assert.ok(repairClaim, "expected a write.root claim with Hard-validate repair feedback");
  assert.ok(
    repairClaim.feedback?.startsWith(HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX),
    `feedback should start with HV prefix: ${repairClaim.feedback}`,
  );
  assert.match(repairClaim.feedback ?? "", /validation failed:/i);
  assert.ok(repairClaim.generation >= 1, "repair write must be a new generation");
  assert.equal(repairClaim.hasWiki, true, "repair write must bind prior wiki_tree");

  const writeNode = atPub.snapshot.nodes.find((n) => n.key === "write.root");
  assert.equal(writeNode?.state, "succeeded");
  assert.ok((writeNode?.generation ?? 0) >= 1);

  const validateFailed = atPub.snapshot.attempts.filter(
    (a) => a.nodeKey === "validate.pre" && a.state === "failed",
  );
  assert.ok(validateFailed.length >= 1, "expected at least one failed validate.pre attempt");
  assert.equal(validateFailed[0]?.failureClass, "schema");
  assert.match(validateFailed[0]?.error ?? "", /validation failed:/i);

  // Durably counted on write.root detail_json.
  await runs.close();
  const db = new DatabaseSync(path.join(root, ".okf-wiki", "workflow.sqlite"));
  const count = countAutoHardValidateRepairs({ db }, receipt.runId);
  db.close();
  assert.equal(count, 1, "exactly one auto HV repair generation");
});

test("auto hard-validate repair exhausts budget and fails the run", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let writeCount = 0;
  const base = planWithHvBudget(1);

  const runs = await openWikiRuns({
    rootPath: root,
    piAttemptExecutor: async (input, signal) => {
      if (input.node.kind === "plan") return base(input, signal);
      if (input.node.kind === "write.root") {
        writeCount += 1;
        await mkdir(input.workDir, { recursive: true });
        // Always dirty so repair cannot clear validation.
        const wikiDir = await writeBadWiki(input.workDir);
        return writeSucceeded(input, wikiDir, `fixture write dirty #${writeCount}`);
      }
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-hv-exhaust" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-hv-exhaust");

  const failed = await waitForRunState(runs, receipt.runId, ["failed"], 60_000);
  assert.equal(failed.snapshot.state, "failed");
  // Initial write + one auto repair (budget=1); no infinite loop.
  assert.equal(writeCount, 2, `expected exactly 2 writes (budget 1), got ${writeCount}`);

  const writeGens = failed.snapshot.nodes
    .filter((n) => n.key === "write.root")
    .map((n) => n.generation);
  // Snapshot shows current max gen only once per key in nodes list — check attempts.
  const writeAttempts = failed.snapshot.attempts.filter((a) => a.nodeKey === "write.root");
  assert.ok(writeAttempts.length >= 2);

  const validateFailed = failed.snapshot.attempts.filter(
    (a) => a.nodeKey === "validate.pre" && a.state === "failed",
  );
  assert.ok(
    validateFailed.length >= 2,
    `expected ≥2 failed validates after budget exhaust, got ${validateFailed.length}`,
  );

  void writeGens;
});

test("maxHardValidateRepairRounds=0 never auto-repairs", async (t) => {
  const { root, workspaceId } = await makeWorkspace();
  t.after(() => removeWorkspace(root));

  let writeCount = 0;
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
      return fullGraphFixtureExecutor(input, signal);
    },
  });
  t.after(() => runs.close());

  const receipt = await runs.dispatch(
    { type: "start_run", commandId: "start-hv-zero" },
    context(workspaceId),
  );
  await approvePlanGate(runs, receipt.runId, workspaceId, "approve-hv-zero");

  const failed = await waitForRunState(runs, receipt.runId, ["failed"], 60_000);
  assert.equal(failed.snapshot.state, "failed");
  assert.equal(writeCount, 1, "budget 0 must not re-run write.root");
  const validateFailed = failed.snapshot.attempts.find(
    (a) => a.nodeKey === "validate.pre" && a.state === "failed",
  );
  assert.ok(validateFailed);
  assert.equal(validateFailed?.failureClass, "schema");
});

describe("shouldAutoHardValidateRepair (unit)", () => {
  function openPolicyDb(opts: {
    cancelRequested?: boolean;
    writeRoot?: boolean;
    repairDetails?: string[];
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
    for (const [i, detail] of (opts.repairDetails ?? []).entries()) {
      db.prepare(
        "INSERT INTO nodes (run_id, node_key, generation, detail_json) VALUES ('run-1', 'write.root', ?, ?)",
      ).run(i + 1, detail);
    }
    return db;
  }

  function host(opts: {
    closed?: boolean;
    cancelRequested?: boolean;
    writeRoot?: boolean;
    repairDetails?: string[];
  }): SchedulerHost {
    return {
      workspace: { limits: { retry: { enabled: true } } } as WorkspaceConfig,
      db: openPolicyDb(opts),
      closed: opts.closed ?? false,
    } as SchedulerHost;
  }

  const validateClaim: ClaimedNode = {
    attemptId: "attempt-v",
    nodeGeneration: 0,
    nodeKey: "validate.pre",
    kind: "validate.pre",
    runId: "run-1",
  };

  it("allows validate.pre schema failure when budget remains", () => {
    assert.equal(
      shouldAutoHardValidateRepair(
        host({}),
        validateClaim,
        "validation failed: overview.md: missing type",
        "schema",
      ),
      true,
    );
  });

  it("denies infrastructure and non-validate kinds", () => {
    assert.equal(
      shouldAutoHardValidateRepair(
        host({}),
        validateClaim,
        "validate requires sealed wiki_tree input",
        "infrastructure",
      ),
      false,
    );
    assert.equal(
      shouldAutoHardValidateRepair(
        host({}),
        { ...validateClaim, kind: "write.root", nodeKey: "write.root" },
        "validation failed: x",
        "schema",
      ),
      false,
    );
  });

  it("denies when budget exhausted by prior Hard-validate repair feedback", () => {
    const details = [
      JSON.stringify({
        feedback: `${HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX}round 1/1):\nvalidation failed: x`,
      }),
    ];
    // loadHardValidateBudget defaults to 2 without sealed spec — seed two repairs.
    const two = [
      ...details,
      JSON.stringify({
        feedback: `${HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX}round 2/2):\nvalidation failed: y`,
      }),
    ];
    assert.equal(
      shouldAutoHardValidateRepair(
        host({ repairDetails: two }),
        validateClaim,
        "validation failed: z",
        "schema",
      ),
      false,
    );
  });

  it("counts autoHardValidate flag and feedback prefix", () => {
    const db = openPolicyDb({
      repairDetails: [
        JSON.stringify({ autoHardValidate: true, feedback: "other" }),
        JSON.stringify({
          feedback: `${HARD_VALIDATE_REPAIR_FEEDBACK_PREFIX}round 2/2):\nok`,
        }),
      ],
    });
    assert.equal(countAutoHardValidateRepairs({ db }, "run-1"), 2);
  });
});
