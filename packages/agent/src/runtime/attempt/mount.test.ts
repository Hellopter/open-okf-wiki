/**
 * Attempt mount: sealed sources/skill hardlink/copy, path asserts, materializeInputs shell.
 */

import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { type PiAttemptInput, PiAttemptInputSchema } from "@okf-wiki/contract/pi-attempt";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { materializeInputs, mountSealedSourceTree } from "./mount.js";

const digest = "b".repeat(64);
const timestamp = "2026-07-30T00:00:00.000Z";

async function baseFixture(
  extras: PiAttemptInput["sealedInputs"] = [],
  node: PiAttemptInput["node"] = {
    key: "write.root",
    kind: "write.root",
    generation: 0,
    runIndex: 1,
  },
): Promise<PiAttemptInput> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-mount-"));
  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const spec = path.join(root, "sealed-spec");
  const executionPlan = path.join(root, "sealed-execution-plan");
  const manifest = path.join(root, "sealed-manifest");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(spec, { recursive: true });
  await mkdir(executionPlan, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await writeFile(path.join(sources, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  const extraRoles = new Set(extras.map((extra) => extra.role));
  if (!extraRoles.has("spec")) {
    await writeFile(
      path.join(spec, "spec.json"),
      `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`,
      "utf8",
    );
  }
  if (!extraRoles.has("execution_plan")) {
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
  }
  if (!extraRoles.has("frozen_run_manifest")) {
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
  }
  return PiAttemptInputSchema.parse({
    runId: "run-mount-1",
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
      ...(!extraRoles.has("spec")
        ? [
            {
              role: "spec",
              artifact: { artifactId: "spec", kind: "spec", digest, sealedAt: timestamp },
              readOnlyPath: spec,
            },
          ]
        : []),
      ...(!extraRoles.has("execution_plan")
        ? [
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
          ]
        : []),
      ...(!extraRoles.has("frozen_run_manifest")
        ? [
            {
              role: "frozen_run_manifest",
              artifact: { artifactId: "manifest", kind: "manifest", digest, sealedAt: timestamp },
              readOnlyPath: manifest,
            },
          ]
        : []),
      ...extras,
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: skill,
    sourcePaths: { main: sources },
  });
}

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

async function cleanup(input: PiAttemptInput): Promise<void> {
  const root = path.dirname(path.dirname(input.attemptDir));
  await unlock(root);
  await rm(root, { recursive: true, force: true });
}

test("materializeInputs mounts sources + skill and creates wiki/analysis", async (t) => {
  const input = await baseFixture();
  t.after(() => cleanup(input));

  const layout = await materializeInputs(input);
  await access(path.join(layout.runWorkDir, "sources", "main", "README.md"));
  await access(path.join(layout.runWorkDir, "skill", "SKILL.md"));
  await access(layout.wikiDir);
  await access(layout.analysisDir);
  // Skill copy is read-only (0444 files).
  const skillMode = (await lstat(path.join(layout.runWorkDir, "skill", "SKILL.md"))).mode & 0o777;
  assert.equal(skillMode, 0o444);
});

test("materializeInputs rejects a Pi envelope missing NodeContract-required inputs", async (t) => {
  const input = await baseFixture([], {
    key: "research.leaf.core.1",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      question: "What is this repository for?",
      scope: "Repository entry points",
    },
  });
  t.after(() => cleanup(input));
  const index = input.sealedInputs.findIndex((sealed) => sealed.role === "execution_plan");
  assert.ok(index >= 0, "fixture must start with a valid execution plan");
  input.sealedInputs.splice(index, 1);

  await assert.rejects(
    () => materializeInputs(input),
    /research\.leaf missing required sealed input\(s\): execution_plan/,
  );
});

test("materializeInputs rejects legacy manifest versions, role names, and filenames", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-legacy-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const v1Dir = path.join(root, "v1");
  await mkdir(v1Dir, { recursive: true });
  await writeFile(
    path.join(v1Dir, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 1,
      intent: { mode: "generate" },
      mode: "generate",
      intentDigest: digest,
      sources: [{ id: "main" }],
    })}\n`,
    "utf8",
  );
  const v1 = await baseFixture([
    {
      role: "frozen_run_manifest",
      artifact: { artifactId: "v1", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: v1Dir,
    },
  ]);
  t.after(() => cleanup(v1));
  await assert.rejects(() => materializeInputs(v1), /sealed frozen_run_manifest is invalid/);

  const oldNameDir = path.join(root, "old-name");
  await mkdir(oldNameDir, { recursive: true });
  await writeFile(
    path.join(oldNameDir, "manifest.json"),
    `${JSON.stringify({ version: 2, intent: { mode: "generate" } })}\n`,
    "utf8",
  );
  const oldName = await baseFixture([
    {
      role: "frozen_run_manifest",
      artifact: { artifactId: "old-name", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: oldNameDir,
    },
  ]);
  t.after(() => cleanup(oldName));
  await assert.rejects(
    () => materializeInputs(oldName),
    /sealed frozen_run_manifest is unreadable/,
  );

  const legacyRole = await baseFixture([
    {
      role: "manifest",
      artifact: { artifactId: "legacy-role", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: oldNameDir,
    },
  ]);
  t.after(() => cleanup(legacyRole));
  await assert.rejects(
    () => materializeInputs(legacyRole),
    /sealed input role is not declared by write\.root: manifest/,
  );
});

test("mountSealedSourceTree prefers hardlink shared mount (Phase 7)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-mount-hl-"));
  try {
    const sealed = path.join(root, "sealed");
    const mountA = path.join(root, "attempt-a", "sources", "main");
    const mountB = path.join(root, "attempt-b", "sources", "main");
    await mkdir(path.join(sealed, "src"), { recursive: true });
    await writeFile(path.join(sealed, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(sealed, "README.md"), "# sealed\n", "utf8");
    // Make sealed read-only like freeze.
    await chmod(path.join(sealed, "src", "a.ts"), 0o444);
    await chmod(path.join(sealed, "README.md"), 0o444);

    const modeA = await mountSealedSourceTree(sealed, mountA, "sealed source main");
    const modeB = await mountSealedSourceTree(sealed, mountB, "sealed source main");
    assert.ok(modeA === "hardlink" || modeA === "copy");
    assert.ok(modeB === "hardlink" || modeB === "copy");
    // Content readable and ordinary (no symlinks).
    assert.equal(await readFile(path.join(mountA, "README.md"), "utf8"), "# sealed\n");
    assert.equal(await readFile(path.join(mountB, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    const st = await lstat(path.join(mountA, "README.md"));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    // Hardlink shares inode with sealed when mode is hardlink.
    if (modeA === "hardlink") {
      const sealedSt = await lstat(path.join(sealed, "README.md"));
      assert.equal(st.ino, sealedSt.ino);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
