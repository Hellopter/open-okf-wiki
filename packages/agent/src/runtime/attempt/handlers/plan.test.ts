/**
 * Thin handlePlan wiring tests (Epic D.4).
 * Plan policy (adaptive, scouts, draft I/O) is covered by plan-phase.test.ts.
 * This file only asserts the Attempt edge: projections → planWikiSpec → unsealed outputs.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PiAttemptInput } from "@okf-wiki/contract/pi-attempt";
import { WorkspaceConfigSchema } from "@okf-wiki/contract/workspace";
import { createFixtureProduceRuntime } from "../../fixture-runner.js";
import { handlePlan, planUncertaintyForPriorSpec } from "./plan.js";

function baseWorkspace(rootPath: string) {
  return WorkspaceConfigSchema.parse({
    version: 3,
    id: "ws",
    name: "Plan Handler Test",
    rootPath,
    sources: [
      {
        id: "main",
        path: path.join(rootPath, "src"),
        applyDefaultIgnores: true,
        ignore: [],
        origin: { type: "path" },
      },
    ],
    model: { id: "openai/test" },
    publicationPath: path.join(rootPath, "published"),
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    limits: { requestTimeoutSeconds: 60 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

async function makeLayout(root: string) {
  const runWorkDir = path.join(root, "run");
  const analysisDir = path.join(runWorkDir, "analysis");
  const sourcesDir = path.join(runWorkDir, "sources");
  const skillDir = path.join(runWorkDir, "skill");
  const attemptDir = path.join(runWorkDir, "attempts", "a1");
  const workDir = path.join(attemptDir, "work");
  await mkdir(analysisDir, { recursive: true });
  await mkdir(sourcesDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  return {
    runWorkDir,
    analysisDir,
    sourcesDir,
    skillDir,
    wikiDir: path.join(runWorkDir, "wiki"),
    sourceMounts: new Map<string, string>([["main", path.join(sourcesDir, "main")]]),
    attemptDir,
    workDir,
    sessionPath: path.join(attemptDir, "session.jsonl"),
  };
}

test("handlePlan fixture revise uses current feedback without a prior Spec input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-plan-handler-"));
  const layout = await makeLayout(root);
  const inputsDir = path.join(layout.runWorkDir, "inputs");
  await mkdir(inputsDir, { recursive: true });
  await writeFile(
    path.join(inputsDir, "intent.json"),
    `${JSON.stringify({ mode: "generate", focus: "Emphasize publication" })}\n`,
    "utf8",
  );

  const workspace = baseWorkspace(root);
  const input: PiAttemptInput = {
    runId: "run-1",
    attemptId: "a1",
    node: {
      key: "plan",
      kind: "plan",
      generation: 1,
      runIndex: 2,
      detail: { feedback: "Narrow to runtime only." },
    },
    inputDigest: "b".repeat(64),
    workspace,
    sealedInputs: [
      {
        role: "sources",
        readOnlyPath: layout.sourcesDir,
        artifact: {
          artifactId: "art-sources",
          kind: "snapshot_set",
          digest: "c".repeat(64),
          sealedAt: new Date().toISOString(),
        },
      },
      {
        role: "skill",
        readOnlyPath: layout.skillDir,
        artifact: {
          artifactId: "art-skill",
          kind: "skill",
          digest: "d".repeat(64),
          sealedAt: new Date().toISOString(),
        },
      },
      {
        role: "frozen_run_manifest",
        readOnlyPath: path.join(root, "sealed-intent-not-read"),
        artifact: {
          artifactId: "art-intent",
          kind: "manifest",
          digest: "e".repeat(64),
          sealedAt: new Date().toISOString(),
        },
      },
    ],
    attemptDir: layout.attemptDir,
    workDir: layout.workDir,
    sessionPath: layout.sessionPath,
    skillPath: layout.skillDir,
    sourcePaths: { main: path.join(layout.sourcesDir, "main") },
  };

  const runtime = createFixtureProduceRuntime();
  const outcome = await handlePlan({
    input,
    layout: {
      runWorkDir: layout.runWorkDir,
      analysisDir: layout.analysisDir,
      sourcesDir: layout.sourcesDir,
      skillDir: layout.skillDir,
      wikiDir: layout.wikiDir,
      sourceMounts: layout.sourceMounts,
    },
    ignores: new Map(),
    runtime,
    resolveModel: async () => {
      throw new Error("fixture must not resolve live model");
    },
    signal: new AbortController().signal,
  });

  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;
  assert.ok(outcome.unsealedArtifacts.some((a) => a.kind === "spec"));
  assert.ok(outcome.unsealedArtifacts.some((a) => a.kind === "transcript"));
  assert.match(outcome.summary ?? "", /Source-grounded wiki for Plan Handler Test/);

  // Unsealed Spec is written under analysis/ (Attempt edge, not plan policy).
  const specArt = outcome.unsealedArtifacts.find((a) => a.kind === "spec");
  assert.ok(specArt);
  const raw = await readFile(specArt!.sourcePath, "utf8");
  assert.match(raw, /overview\.md/);
});

test("planUncertaintyForPriorSpec is re-exported from plan deep module", () => {
  assert.equal(planUncertaintyForPriorSpec(undefined), 0);
});
