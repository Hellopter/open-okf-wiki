import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import type { ClaimedNode } from "../types.js";
import type { MechanicalHost } from "./host.js";
import {
  hasGateBlockingDefects,
  mechanicalReviewReduce,
  mergeSeatFindings,
  parseSeatDefectReport,
  parseSeatFinding,
} from "./review-reduce.js";

test("parseSeatDefectReport accepts valid DefectReport JSON", () => {
  const result = parseSeatDefectReport(
    "review.seat.coverage",
    JSON.stringify({
      version: 1,
      reviewerId: "coverage",
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "missing_page",
          issue: "overview page missing citations",
          reviewerId: "coverage",
        },
      ],
      summary: "blocking issues",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.finding.clean, false);
  assert.equal(result.finding.defects.length, 1);
  assert.equal(result.finding.defects[0]?.severity, "blocking");
});

test("parseSeatDefectReport rejects empty artifact (never clean)", () => {
  const result = parseSeatDefectReport("review.seat.grounding", "");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /empty|never treated as clean/i);
});

test("parseSeatDefectReport rejects NO_DEFECTS keyword alone", () => {
  const result = parseSeatDefectReport("review.seat.grounding", "NO_DEFECTS");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /not valid JSON|DefectReport/i);
});

test("parseSeatDefectReport rejects unstructured text", () => {
  const result = parseSeatDefectReport("review.seat.general", "looks fine to me");
  assert.equal(result.ok, false);
});

test("parseSeatDefectReport rejects clean with defects", () => {
  const result = parseSeatDefectReport(
    "review.seat.grounding",
    JSON.stringify({
      reviewerId: "grounding",
      clean: true,
      defects: [{ severity: "major", code: "x", issue: "noise" }],
    }),
  );
  assert.equal(result.ok, false);
});

test("parseSeatFinding throws on malformed (fail-closed)", () => {
  assert.throws(
    () => parseSeatFinding("review.seat.grounding", "NO_DEFECTS"),
    /DefectReport|JSON/i,
  );
});

test("mergeSeatFindings fail-closed on any blocking seat", () => {
  const clean = parseSeatFinding(
    "review.seat.grounding",
    JSON.stringify({
      version: 1,
      reviewerId: "grounding",
      clean: true,
      defects: [],
      summary: "NO_DEFECTS",
    }),
  );
  const dirty = parseSeatFinding(
    "review.seat.coverage",
    JSON.stringify({
      version: 1,
      reviewerId: "coverage",
      clean: false,
      defects: [
        {
          severity: "blocking",
          code: "x",
          issue: "broken claim",
          reviewerId: "coverage",
        },
      ],
    }),
  );
  const merged = mergeSeatFindings([clean, dirty]);
  assert.equal(merged.clean, false);
  assert.ok(merged.defects.some((d) => d.severity === "blocking"));
  assert.ok(hasGateBlockingDefects(merged, ["blocking"]));
});

test("mergeSeatFindings is clean when all seats clean", () => {
  const merged = mergeSeatFindings([
    parseSeatFinding(
      "review.seat.grounding",
      JSON.stringify({ version: 1, reviewerId: "grounding", clean: true, defects: [] }),
    ),
    parseSeatFinding(
      "review.seat.coverage",
      JSON.stringify({ version: 1, reviewerId: "coverage", clean: true, defects: [] }),
    ),
  ]);
  assert.equal(merged.clean, true);
  assert.equal(merged.defects.length, 0);
});

test("hasGateBlockingDefects respects blockingSeverities major", () => {
  const merged = mergeSeatFindings([
    parseSeatFinding(
      "review.seat.grounding",
      JSON.stringify({
        version: 1,
        reviewerId: "grounding",
        clean: false,
        defects: [
          {
            severity: "major",
            code: "weak_grounding",
            issue: "weak citation",
            reviewerId: "grounding",
          },
        ],
      }),
    ),
  ]);
  assert.equal(hasGateBlockingDefects(merged, ["blocking"]), false);
  assert.equal(hasGateBlockingDefects(merged, ["blocking", "major"]), true);
});

function stubReduceHost(): MechanicalHost {
  const workspace = {
    version: 3,
    id: "ws",
    name: "Reduce Test",
    rootPath: "/tmp",
    sources: [],
    model: { id: "fixture/model" },
    publicationPath: "/tmp/published",
    orchestration: { maxActiveRuns: 1, maxConcurrentAttempts: 1 },
    createdAt: "2026-07-30T00:00:00.000Z",
  } as unknown as WorkspaceConfig;
  return {
    workspace,
    workspaceForRun: () => workspace,
    db: {
      prepare: () => ({
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
    } as unknown as MechanicalHost["db"],
    emit: () => 0,
    transaction: <T>(work: () => T) => work(),
    trustedPinnedInputs: () => undefined,
    currentNodeGeneration: () => 0,
    reconcileApplyingEffect: async () => undefined,
  };
}

test("review.reduce missing wiki_tree writes terminal error transcript", async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), "okf-reduce-fail-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const claim: ClaimedNode = {
    attemptId: "attempt-reduce-1",
    nodeGeneration: 0,
    nodeKey: "review.reduce",
    kind: "review.reduce",
    runId: "run-1",
  };
  const workDir = path.join(runDir, "attempts", claim.attemptId, "work");
  await mkdir(workDir, { recursive: true });

  const outcome = await mechanicalReviewReduce(stubReduceHost(), claim, workDir, runDir);
  assert.equal(outcome.type, "failed");
  if (outcome.type === "failed") {
    assert.equal(outcome.failureClass, "infrastructure");
    assert.match(outcome.error, /wiki_tree/i);
  }

  const sessionPath = path.join(runDir, "attempts", claim.attemptId, "session.jsonl");
  const raw = await readFile(sessionPath, "utf8");
  assert.match(raw, /wiki_tree/i);
  assert.match(raw, /"status"\s*:\s*"error"/);
});

test("review.reduce missing seats writes schema error transcript", async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), "okf-reduce-seats-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const claim: ClaimedNode = {
    attemptId: "attempt-reduce-2",
    nodeGeneration: 0,
    nodeKey: "review.reduce",
    kind: "review.reduce",
    runId: "run-1",
  };
  const workDir = path.join(runDir, "attempts", claim.attemptId, "work");
  await mkdir(workDir, { recursive: true });

  const wikiRel = "artifacts/wiki";
  await mkdir(path.join(runDir, wikiRel), { recursive: true });

  const host = stubReduceHost();
  host.db = {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => {
        if (params[1] === "wiki_tree") return { relative_path: wikiRel };
        return undefined;
      },
      all: () => {
        // Configured seats only — zero bound seat artifacts → schema fail.
        if (sql.includes("kind = 'review.seat'")) {
          return [{ node_key: "review.seat.grounding" }];
        }
        return [];
      },
      run: () => ({ changes: 0 }),
    }),
  } as unknown as MechanicalHost["db"];

  const outcome = await mechanicalReviewReduce(host, claim, workDir, runDir);
  assert.equal(outcome.type, "failed");
  if (outcome.type === "failed") {
    assert.equal(outcome.failureClass, "schema");
    assert.match(outcome.error, /no seat artifacts|never NO_DEFECTS|reviewRequired/i);
  }

  const sessionPath = path.join(runDir, "attempts", claim.attemptId, "session.jsonl");
  const raw = await readFile(sessionPath, "utf8");
  assert.match(raw, /seat|NO_DEFECTS|reviewRequired/i);
  assert.match(raw, /"status"\s*:\s*"error"/);
});
