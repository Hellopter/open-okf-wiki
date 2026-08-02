/**
 * Mechanical validate failure paths write error transcripts at the source.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import type { ClaimedNode } from "../types.js";
import type { MechanicalHost } from "./host.js";
import { mechanicalValidate } from "./validate.js";

function stubHost(): MechanicalHost {
  const workspace = {
    version: 3,
    id: "ws",
    name: "Validate Test",
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

function claim(kind: "validate.pre" | "validate.final" = "validate.pre"): ClaimedNode {
  return {
    attemptId: "attempt-validate-1",
    nodeGeneration: 0,
    nodeKey: kind,
    kind,
    runId: "run-1",
  };
}

test("validate missing wiki_tree writes terminal error transcript", async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), "okf-validate-fail-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const c = claim();
  const workDir = path.join(runDir, "attempts", c.attemptId, "work");
  await mkdir(workDir, { recursive: true });

  const outcome = await mechanicalValidate(stubHost(), c, workDir, runDir);
  assert.equal(outcome.type, "failed");
  if (outcome.type === "failed") {
    assert.equal(outcome.failureClass, "infrastructure");
    assert.match(outcome.error, /wiki_tree/i);
    assert.ok(outcome.unsealedArtifacts?.some((a) => a.role === "transcript"));
  }

  const sessionPath = path.join(runDir, "attempts", c.attemptId, "session.jsonl");
  const raw = await readFile(sessionPath, "utf8");
  assert.match(raw, /wiki_tree/i);
  assert.match(raw, /"status"\s*:\s*"error"/);
});

test("validate dirty wiki writes error transcript and keeps validate_report", async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), "okf-validate-dirty-"));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const c = claim("validate.final");
  const workDir = path.join(runDir, "attempts", c.attemptId, "work");
  await mkdir(workDir, { recursive: true });

  // Sealed wiki without required frontmatter → mechanical dirty.
  const wikiRel = "artifacts/wiki";
  const wikiAbs = path.join(runDir, wikiRel);
  await mkdir(wikiAbs, { recursive: true });
  await writeFile(path.join(wikiAbs, "overview.md"), "# No frontmatter\n\nBroken page.\n", "utf8");

  const host = stubHost();
  host.db = {
    prepare: () => ({
      get: (...params: unknown[]) => {
        // sealedInputPath(host, claim, runDir, role) → .get(attemptId, role)
        if (params[1] === "wiki_tree") return { relative_path: wikiRel };
        return undefined;
      },
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  } as unknown as MechanicalHost["db"];

  const outcome = await mechanicalValidate(host, c, workDir, runDir);
  assert.equal(outcome.type, "failed");
  if (outcome.type === "failed") {
    assert.equal(outcome.failureClass, "schema");
    assert.match(outcome.error, /validation failed/i);
    assert.ok(outcome.unsealedArtifacts?.some((a) => a.role === "validate_report"));
    assert.ok(outcome.unsealedArtifacts?.some((a) => a.role === "transcript"));
  }

  const sessionPath = path.join(runDir, "attempts", c.attemptId, "session.jsonl");
  const raw = await readFile(sessionPath, "utf8");
  assert.match(raw, /validation failed/i);
  assert.match(raw, /"status"\s*:\s*"error"/);
});
