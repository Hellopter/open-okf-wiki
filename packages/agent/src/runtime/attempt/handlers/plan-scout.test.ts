/**
 * handlePlanScout fixture wiring (U2 durable plan.scout).
 */

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type PiAttemptInput, PiAttemptInputSchema } from "@okf-wiki/contract/pi-attempt";
import { createFixtureProduceRuntime } from "../../fixture-runner.js";
import { createPiAttemptExecutor } from "../../pi-attempt-executor.js";
import { handlePlanScout } from "./plan-scout.js";
import { runWorkdirLayout } from "../../workdir.js";

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

async function fixture(
  node: PiAttemptInput["node"],
  opts?: { runtime?: ReturnType<typeof createFixtureProduceRuntime> },
): Promise<{ input: PiAttemptInput; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-plan-scout-"));
  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const manifest = path.join(root, "sealed-manifest");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(manifest, { recursive: true });
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
  const input = PiAttemptInputSchema.parse({
    runId: "run-scout-1",
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
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: skill,
    sourcePaths: { main: sources },
  });
  void opts;
  return { input, root };
}

test("handlePlanScout fixture succeeds with scout_receipt + transcript", async (t) => {
  const { input, root } = await fixture({
    key: "plan.scout.entry",
    kind: "plan.scout",
    generation: 0,
    runIndex: 1,
    detail: {
      scoutKind: "entry",
      critical: false,
      taskLabel: "thematic:entry",
    },
  });
  t.after(() => cleanupRoot(root));

  const outcome = await createPiAttemptExecutor({ fixture: true })(
    input,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;

  const receiptArt = outcome.unsealedArtifacts.find((a) => a.role === "scout_receipt");
  assert.ok(receiptArt, "expected scout_receipt unsealed artifact");
  assert.equal(receiptArt.kind, "receipt");
  assert.ok(outcome.unsealedArtifacts.some((a) => a.role === "transcript"));

  const raw = JSON.parse(await readFile(receiptArt.sourcePath, "utf8")) as {
    version: number;
    kind: string;
    ok: boolean;
    summary: string;
    critical: boolean;
  };
  assert.equal(raw.version, 1);
  assert.equal(raw.kind, "entry");
  assert.equal(raw.critical, false);
  assert.equal(raw.ok, true);
  assert.ok(typeof raw.summary === "string");

  // Markdown report co-located under analysis/plan-scouts/
  const mdPath = path.join(
    path.dirname(receiptArt.sourcePath),
    "entry.md",
  );
  const md = await readFile(mdPath, "utf8");
  assert.match(md, /Plan scout/);
});

test("handlePlanScout critical empty summary fails closed", async (t) => {
  const { input, root } = await fixture({
    key: "plan.scout.source-api",
    kind: "plan.scout",
    generation: 0,
    runIndex: 1,
    detail: {
      scoutKind: "source",
      sourceId: "api",
      unitId: "api",
      critical: true,
      taskLabel: "source:api",
    },
  });
  t.after(() => cleanupRoot(root));

  // Live-shaped runtime that returns empty summary (fail-closed for critical).
  const runtime = {
    ...createFixtureProduceRuntime({
      onAgent: async () => ({
        role: "root_research" as const,
        mode: "fixture" as const,
        summary: "   ",
      }),
    }),
    kind: "live" as const,
  };

  // Materialize then call handler with live-shaped empty scout.
  const executor = createPiAttemptExecutor({ runtime });
  // Without a model, live plan scout still uses runtime.runAgent via runOnePlanScout.
  // Fixture adapter does not need a real model.
  const outcome = await executor(input, new AbortController().signal);
  assert.equal(outcome.type, "failed");
  if (outcome.type !== "failed") return;
  assert.match(outcome.error, /critical plan scout|empty|coverage gap/i);
});

test("handlePlanScout optional empty summary succeeds", async (t) => {
  const { input, root } = await fixture({
    key: "plan.scout.layout",
    kind: "plan.scout",
    generation: 0,
    runIndex: 1,
    detail: {
      scoutKind: "layout",
      critical: false,
      taskLabel: "thematic:layout",
    },
  });
  t.after(() => cleanupRoot(root));

  const runtime = {
    ...createFixtureProduceRuntime({
      onAgent: async () => ({
        role: "root_research" as const,
        mode: "fixture" as const,
        summary: "",
      }),
    }),
    kind: "live" as const,
  };

  const outcome = await createPiAttemptExecutor({ runtime })(
    input,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;
  const receiptArt = outcome.unsealedArtifacts.find((a) => a.role === "scout_receipt");
  assert.ok(receiptArt);
  const raw = JSON.parse(await readFile(receiptArt.sourcePath, "utf8")) as {
    ok: boolean;
    critical: boolean;
  };
  assert.equal(raw.critical, false);
  // Optional empty is still ok:true for thematic (required=false, emptyRequired=false).
  assert.equal(raw.ok, true);
});

test("planScoutTaskFromDetail via handlePlanScout rejects missing scoutKind", async (t) => {
  const { input, root } = await fixture({
    key: "plan.scout.entry",
    kind: "plan.scout",
    generation: 0,
    runIndex: 1,
    detail: {
      // Missing scoutKind — dynamic detail should fail at scheduler, but if
      // we call handler with empty detail it must fail closed.
      critical: false,
    },
  });
  t.after(() => cleanupRoot(root));

  // Bypass materialize: call handler with a hand-built layout (missing detail fields).
  const workDir = input.workDir;
  await mkdir(path.join(workDir, "sources", "main"), { recursive: true });
  await mkdir(path.join(workDir, "skill"), { recursive: true });
  await mkdir(path.join(workDir, "analysis"), { recursive: true });
  await mkdir(path.join(workDir, "wiki"), { recursive: true });
  const layout = runWorkdirLayout(
    workDir,
    new Map([["main", path.join(workDir, "sources", "main")]]),
  );

  await assert.rejects(
    () =>
      handlePlanScout({
        input: {
          ...input,
          node: {
            ...input.node,
            detail: { critical: false },
          },
        },
        layout,
        ignores: new Map(),
        runtime: createFixtureProduceRuntime(),
        resolveModel: async () => {
          throw new Error("no model");
        },
        signal: new AbortController().signal,
      }),
    /scoutKind/,
  );
});
