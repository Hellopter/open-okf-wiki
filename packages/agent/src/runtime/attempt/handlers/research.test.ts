/**
 * Phase 2: research handlers emit full AnalysisReceiptSchema (no thin receipts).
 */

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AnalysisReceiptSchema,
  type PiAttemptInput,
  PiAttemptInputSchema,
} from "@okf-wiki/contract";
import { createFixtureProduceRuntime } from "../../fixture-runner.js";
import { createPiAttemptExecutor } from "../../pi-attempt-executor.js";
import { evidenceFromSummary, findingsFromSummary } from "./research.js";

async function unlock(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(directory, 0o755).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await unlock(child);
    else await chmod(child, 0o644).catch(() => undefined);
  }
}

async function cleanupRoot(root: string): Promise<void> {
  await unlock(root);
  await rm(root, { recursive: true, force: true });
}

const digest = "e".repeat(64);
const timestamp = "2026-07-30T00:00:00.000Z";

async function fixture(node: PiAttemptInput["node"]): Promise<PiAttemptInput> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-research-receipt-"));
  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const manifest = path.join(root, "sealed-manifest");
  const executionPlan = path.join(root, "sealed-execution-plan");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await mkdir(executionPlan, { recursive: true });
  await writeFile(path.join(sources, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  await writeFile(
    path.join(manifest, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 2,
      intent: { mode: "generate" },
      mode: "generate",
      intentDigest: digest,
      sources: [{ id: "main" }],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(executionPlan, "execution-plan.json"),
    `${JSON.stringify({
      version: 4,
      workUnits: [],
      reviewLenses: [],
      fanOut: { domainCount: 0, leafCount: 0, maxDomainFanOut: 1, maxLeafFanOut: 1 },
      adaptation: { required: false, maxRounds: 0 },
    })}\n`,
    "utf8",
  );
  return PiAttemptInputSchema.parse({
    runId: "run-research-1",
    attemptId: "attempt-1",
    node,
    inputDigest: digest,
    workspace: {
      version: 3,
      id: "workspace-1",
      name: "Demo",
      rootPath: root,
      sources: [
        {
          id: "main",
          path: sources,
          applyDefaultIgnores: true,
          ignore: [],
          origin: { type: "path" },
        },
      ],
      model: { id: "fixture/model" },
      publicationPath: path.join(root, "published"),
      orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
      createdAt: timestamp,
    },
    sealedInputs: [
      {
        role: "sources",
        artifact: { artifactId: "sources", kind: "snapshot_set", digest, sealedAt: timestamp },
        readOnlyPath: sources,
      },
      {
        role: "skill",
        artifact: { artifactId: "skill", kind: "skill", digest, sealedAt: timestamp },
        readOnlyPath: skill,
      },
      {
        role: "frozen_run_manifest",
        artifact: { artifactId: "manifest", kind: "manifest", digest, sealedAt: timestamp },
        readOnlyPath: manifest,
      },
      {
        role: "execution_plan",
        artifact: {
          artifactId: "execution-plan",
          kind: "execution_plan",
          digest,
          sealedAt: timestamp,
        },
        readOnlyPath: executionPlan,
      },
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: skill,
    sourcePaths: { main: sources },
  });
}

test("research.leaf output parses as AnalysisReceiptSchema (not thin role/summary/mode)", async (t) => {
  const input = await fixture({
    key: "research.leaf.core.1",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      questionIndex: 1,
      question: "What is this repository for?",
      scope: "entry",
    },
  });
  t.after(() => cleanupRoot(path.dirname(path.dirname(input.attemptDir))));

  const outcome = await createPiAttemptExecutor({ fixture: true })(
    input,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;
  const receiptArt = outcome.unsealedArtifacts.find((a) => a.role === "research");
  assert.ok(receiptArt);
  const raw = JSON.parse(await readFile(receiptArt.sourcePath, "utf8")) as unknown;
  const parsed = AnalysisReceiptSchema.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.nodeId, "research.leaf.core.1");
  assert.equal(parsed.runId, "run-research-1");
  assert.ok(parsed.findings.length >= 1);
  assert.ok(Array.isArray(parsed.evidence));
  assert.ok(Array.isArray(parsed.childReceipts));
  // Thin shape must be gone.
  assert.equal((raw as { role?: string }).role, undefined);
  assert.equal((raw as { mode?: string }).mode, undefined);
});

test("research.domain populates childReceipts from projected evidence", async (t) => {
  const input = await fixture({
    key: "research.domain.core",
    kind: "research.domain",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      title: "Core",
      scope: "entry",
      questions: ["What is this repository for?"],
    },
  });
  t.after(() => cleanupRoot(path.dirname(path.dirname(input.attemptDir))));

  // Pre-seal a child leaf receipt and bind it.
  const leafReceipt = AnalysisReceiptSchema.parse({
    version: 1,
    runId: "run-research-1",
    nodeId: "research.leaf.core.1",
    parentId: "research.domain.core",
    attempt: 1,
    status: "complete",
    scope: "entry",
    summary: "- Main entry is README\n- Build uses pnpm",
    findings: ["Main entry is README", "Build uses pnpm"],
    evidence: [{ repositoryId: "main", path: "README.md" }],
    childReceipts: [],
    openQuestions: [],
  });
  const leafDir = path.join(path.dirname(path.dirname(input.attemptDir)), "sealed-leaf");
  await mkdir(leafDir, { recursive: true });
  await writeFile(path.join(leafDir, "leaf.json"), `${JSON.stringify(leafReceipt)}\n`, "utf8");
  input.sealedInputs.push({
    role: "research.leaf.core.1:research",
    artifact: {
      artifactId: "leaf-receipt",
      kind: "receipt",
      digest: digest,
      sealedAt: timestamp,
    },
    readOnlyPath: leafDir,
  });

  const outcome = await createPiAttemptExecutor({
    runtime: createFixtureProduceRuntime(),
  })(input, new AbortController().signal);
  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;
  const receiptArt = outcome.unsealedArtifacts.find((a) => a.role === "research");
  assert.ok(receiptArt);
  const parsed = AnalysisReceiptSchema.parse(
    JSON.parse(await readFile(receiptArt.sourcePath, "utf8")),
  );
  assert.ok(
    parsed.childReceipts.includes("research.leaf.core.1"),
    `expected childReceipts to include leaf, got ${JSON.stringify(parsed.childReceipts)}`,
  );
  assert.equal(parsed.nodeId, "research.domain.core");
});

test("findingsFromSummary and evidenceFromSummary helpers", () => {
  const findings = findingsFromSummary("- one\n- two\n- three");
  assert.deepEqual(findings, ["one", "two", "three"]);
  const evidence = evidenceFromSummary("See sources/main/src/a.ts#L1-L5 and repo:main/b.ts#L2");
  assert.ok(evidence.length >= 1);
  assert.ok(evidence.some((e) => e.path.includes("a.ts") || e.path.includes("b.ts")));
});
