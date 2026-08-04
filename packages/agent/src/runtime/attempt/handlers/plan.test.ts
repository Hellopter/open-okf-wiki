/**
 * Thin handlePlan wiring tests (Epic D.4).
 * Plan policy (adaptive, scouts, draft I/O) is covered by plan-phase.test.ts.
 * This file asserts the Attempt edge: projections → planWikiSpec → unsealed outputs,
 * and WP-B gateFailure passthrough for dual product gates.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PiAttemptInput } from "@okf-wiki/contract/pi-attempt";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { WorkspaceConfigSchema } from "@okf-wiki/contract/workspace";
import { commitPlanDraft } from "../../../plan/commit-plan-draft.js";
import type { AgentRunRequest } from "../../../ports/agent-runner.js";
import { createFixtureProduceRuntime } from "../../fixture-runner.js";
import type { ResolvedPiModel } from "../../model/provider-model.js";
import { handlePlan, planUncertaintyForPriorSpec } from "./plan.js";

/** Minimal live-model stub — planWikiSpec only needs model.id for live path. */
function stubResolvedModel(): ResolvedPiModel {
  return {
    model: { id: "fixture/model", contextWindow: 128_000 },
    modelRuntime: undefined,
    providerId: "fixture",
    servedModelId: "model",
    providerKind: "openai",
    runtime: { modelId: "fixture/model" },
  } as unknown as ResolvedPiModel;
}

function baseWorkspace(rootPath: string, sourceIds: string[] = ["main"]) {
  return WorkspaceConfigSchema.parse({
    version: 3,
    id: "ws",
    name: "Plan Handler Test",
    rootPath,
    sources: sourceIds.map((id) => ({
      id,
      path: path.join(rootPath, "src", id),
      applyDefaultIgnores: true,
      ignore: [],
      origin: { type: "path" as const },
    })),
    model: { id: "openai/test" },
    publicationPath: path.join(rootPath, "published"),
    orchestration: {
      maxActiveRuns: 2,
      maxConcurrentAttempts: 4,
      planScoutCount: 0,
      planRescoutMaxRounds: 1,
      maxSourcesPerRun: 8,
    },
    limits: { requestTimeoutSeconds: 60 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

async function makeLayout(root: string, sourceIds: string[] = ["main"]) {
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
  const sourceMounts = new Map<string, string>();
  for (const id of sourceIds) {
    const mount = path.join(sourcesDir, id);
    await mkdir(mount, { recursive: true });
    await writeFile(path.join(mount, "README.md"), `# ${id}\n`, "utf8");
    sourceMounts.set(id, mount);
  }
  return {
    runWorkDir,
    analysisDir,
    sourcesDir,
    skillDir,
    wikiDir: path.join(runWorkDir, "wiki"),
    sourceMounts,
    attemptDir,
    workDir,
    sessionPath: path.join(attemptDir, "session.jsonl"),
  };
}

function layoutCtx(layout: Awaited<ReturnType<typeof makeLayout>>) {
  return {
    runWorkDir: layout.runWorkDir,
    analysisDir: layout.analysisDir,
    sourcesDir: layout.sourcesDir,
    skillDir: layout.skillDir,
    wikiDir: layout.wikiDir,
    sourceMounts: layout.sourceMounts,
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

test("handlePlan maps SemanticSufficiencyError to semantic_gap + gateFailure.gaps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-plan-handler-semantic-"));
  const sourceIds = ["api", "web"];
  const layout = await makeLayout(root, sourceIds);
  const inputsDir = path.join(layout.runWorkDir, "inputs");
  await mkdir(inputsDir, { recursive: true });
  // Incomplete DiscoveryMap so dual gate fails closed on multi-source.
  await writeFile(
    path.join(inputsDir, "discovery-map.json"),
    `${JSON.stringify({
      version: 1,
      sources: [
        { sourceId: "api", entryPoints: ["README.md"], evidencePaths: [] },
        { sourceId: "web", entryPoints: ["README.md"], evidencePaths: [] },
      ],
      domains: [],
      flows: [],
      concepts: [],
      openQuestions: [],
    })}\n`,
    "utf8",
  );

  const workspace = baseWorkspace(root, sourceIds);
  const input: PiAttemptInput = {
    runId: "run-semantic",
    attemptId: "a1",
    node: { key: "plan", kind: "plan", generation: 0, runIndex: 1 },
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
    ],
    attemptDir: layout.attemptDir,
    workDir: layout.workDir,
    sessionPath: layout.sessionPath,
    skillPath: layout.skillDir,
    sourcePaths: Object.fromEntries(
      sourceIds.map((id) => [id, path.join(layout.sourcesDir, id)]),
    ),
  };

  const base = createFixtureProduceRuntime({
    onAgent: async (req: AgentRunRequest) => {
      if (req.role === "plan") {
        // Coverage-complete Spec so only the semantic dual gate fails.
        const units = ["api", "web"];
        const baseSpec = defaultWikiRunSpec("Multi Semantic");
        const domainId = baseSpec.domains[0]!.id;
        const spec = {
          ...baseSpec,
          pages: [
            {
              path: "overview.md",
              purpose: "cover sources",
              critical: true as const,
              domainIds: [domainId],
              coverageUnitIds: units,
              sourceIds: units,
            },
          ],
          sourceCoverage: units.map((sourceId) => ({
            sourceId,
            pagePaths: ["overview.md"],
          })),
        };
        await commitPlanDraft(layout.runWorkDir, spec);
        return {
          role: "plan",
          mode: "fixture",
          summary: "plan with coverage but semantic gaps",
        };
      }
      return { role: req.role, mode: "fixture", summary: `unexpected ${req.role}` };
    },
  });
  const runtime = { ...base, kind: "live" as const };

  const outcome = await handlePlan({
    input,
    layout: layoutCtx(layout),
    ignores: new Map(),
    runtime,
    resolveModel: async () => stubResolvedModel(),
    signal: new AbortController().signal,
  });

  assert.equal(outcome.type, "failed");
  if (outcome.type !== "failed") return;
  assert.equal(outcome.failureClass, "semantic_gap");
  assert.ok(outcome.gateFailure, "expected structured gateFailure");
  assert.equal(outcome.gateFailure.kind, "semantic_sufficiency");
  assert.equal(outcome.gateFailure.code, "SEMANTIC_GAP");
  assert.ok(Array.isArray(outcome.gateFailure.gaps));
  assert.ok(
    (outcome.gateFailure.gaps?.length ?? 0) > 0,
    "gateFailure.gaps must be non-empty for host re-arm",
  );
  assert.match(outcome.error, /semantic sufficiency/i);
});

test("handlePlan maps CoverageAssertError to coverage_gap + gateFailure.gaps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-plan-handler-coverage-"));
  const sourceIds = ["backend", "frontend"];
  const layout = await makeLayout(root, sourceIds);
  const workspace = baseWorkspace(root, sourceIds);
  const input: PiAttemptInput = {
    runId: "run-coverage",
    attemptId: "a1",
    node: { key: "plan", kind: "plan", generation: 0, runIndex: 1 },
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
    ],
    attemptDir: layout.attemptDir,
    workDir: layout.workDir,
    sessionPath: layout.sessionPath,
    skillPath: layout.skillDir,
    sourcePaths: Object.fromEntries(
      sourceIds.map((id) => [id, path.join(layout.sourcesDir, id)]),
    ),
  };

  // No discovery-map → semantic gate soft-skips; coverage assert fails on unbound frontend.
  const base = createFixtureProduceRuntime({
    onAgent: async (req: AgentRunRequest) => {
      if (req.role === "plan") {
        const baseSpec = defaultWikiRunSpec("Coverage Gap Multi");
        await commitPlanDraft(layout.runWorkDir, {
          ...baseSpec,
          pages: [
            {
              path: "overview.md",
              purpose: "partial",
              critical: true,
              domainIds: [baseSpec.domains[0]!.id],
              coverageUnitIds: ["backend"],
              sourceIds: ["backend"],
            },
          ],
          sourceCoverage: [{ sourceId: "backend", pagePaths: ["overview.md"] }],
        });
        return {
          role: "plan",
          mode: "fixture",
          summary: "partial coverage",
        };
      }
      return { role: req.role, mode: "fixture", summary: `unexpected ${req.role}` };
    },
  });
  const runtime = { ...base, kind: "live" as const };

  const outcome = await handlePlan({
    input,
    layout: layoutCtx(layout),
    ignores: new Map(),
    runtime,
    resolveModel: async () => stubResolvedModel(),
    signal: new AbortController().signal,
  });

  assert.equal(outcome.type, "failed");
  if (outcome.type !== "failed") return;
  assert.equal(outcome.failureClass, "coverage_gap");
  assert.ok(outcome.gateFailure, "expected structured gateFailure");
  assert.equal(outcome.gateFailure.kind, "coverage");
  assert.equal(outcome.gateFailure.code, "COVERAGE_GAP");
  assert.ok(Array.isArray(outcome.gateFailure.gaps));
  assert.ok(
    (outcome.gateFailure.gaps?.length ?? 0) > 0,
    "gateFailure.gaps must be non-empty for host re-arm",
  );
  assert.match(outcome.error, /coverage/i);
});
