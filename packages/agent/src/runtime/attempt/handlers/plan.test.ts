/**
 * Phase 1: handlePlan wires operatorNotes / priorSpec / revisionFeedback.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  defaultWikiRunSpec,
  type PiAttemptInput,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import { createFixtureProduceRuntime } from "../../fixture-runner.js";
import { handlePlan } from "./plan.js";

function baseWorkspace(rootPath: string) {
  return WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws",
    name: "Plan Handler Test",
    rootPath,
    sources: [{ id: "main", path: path.join(rootPath, "src"), applyDefaultIgnores: true, ignore: [] }],
    model: { id: "openai/test" },
    publicationPath: path.join(rootPath, "published"),
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

test("handlePlan fixture revise passes priorSpec and revisionFeedback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-plan-handler-"));
  const layout = await makeLayout(root);
  const prior = defaultWikiRunSpec("Prior");
  prior.summary = "Prior summary for revise";
  const priorDir = path.join(layout.runWorkDir, "prior-spec");
  await mkdir(priorDir, { recursive: true });
  await writeFile(path.join(priorDir, "spec.json"), `${JSON.stringify(prior)}\n`, "utf8");

  const intentDir = path.join(layout.runWorkDir, "intent");
  await mkdir(intentDir, { recursive: true });
  await writeFile(
    path.join(intentDir, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 1,
      intent: { mode: "generate", focus: "Emphasize publication" },
      mode: "generate",
      intentDigest: "a".repeat(64),
      sources: [],
    })}\n`,
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
        readOnlyPath: intentDir,
        artifact: {
          artifactId: "art-intent",
          kind: "manifest",
          digest: "e".repeat(64),
          sealedAt: new Date().toISOString(),
        },
      },
      {
        role: "prior_spec",
        readOnlyPath: priorDir,
        artifact: {
          artifactId: "art-prior",
          kind: "spec",
          digest: "f".repeat(64),
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
  // Fixture planWikiSpec uses priorSpec when provided.
  assert.ok(outcome.unsealedArtifacts.some((a) => a.kind === "spec"));
  assert.match(outcome.summary ?? "", /Prior summary|Fixture|WikiRunSpec/i);
});
