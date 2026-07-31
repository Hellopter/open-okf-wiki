import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type WorkspaceConfig, WorkspaceConfigSchema } from "@okf-wiki/contract";
import { FreezeWikiRunError, freezeRunBoundary } from "./run-boundary.js";
import { skillDigest } from "./skill-digest.js";

async function makeGitRepo(parent: string, name: string): Promise<string> {
  const dir = path.join(parent, name);
  await mkdir(dir, { recursive: true });
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  await writeFile(path.join(dir, "README.md"), "# src\n", "utf8");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

async function makeWorkspace(opts?: {
  dirty?: boolean;
  noSources?: boolean;
}): Promise<{ root: string; workspace: WorkspaceConfig; skillDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-freeze-"));
  const skillDir = path.join(root, "skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: test-skill\n---\n# skill\n", "utf8");

  let sources: WorkspaceConfig["sources"] = [];
  if (!opts?.noSources) {
    const src = await makeGitRepo(root, "src");
    if (opts?.dirty) {
      await writeFile(path.join(src, "dirty.txt"), "x\n", "utf8");
    }
    sources = [
      {
        id: "main",
        path: src,
        applyDefaultIgnores: true,
        ignore: [],
        origin: { type: "path" },
      },
    ];
  }

  const workspace = WorkspaceConfigSchema.parse({
    version: 2,
    id: "ws1",
    name: "Freeze WS",
    rootPath: root,
    sources,
    skillPath: skillDir,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "wiki-out"),
    limits: { requestTimeoutSeconds: 60 },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });

  return { root, workspace, skillDir };
}

test("freezeRunBoundary freezes sources and Skill without creating a v2 Run Record", async () => {
  const { root, workspace } = await makeWorkspace();
  const runId = "allocated-run";
  const frozen = await freezeRunBoundary({ workspace, runId });

  assert.equal(frozen.runId, runId);
  assert.equal(frozen.runWorkDir, path.join(root, ".okf-wiki", "runs", runId));
  assert.equal(frozen.wikiDir, path.join(frozen.runWorkDir, "wiki"));
  assert.equal(frozen.analysisDir, path.join(frozen.runWorkDir, "analysis"));
  assert.equal(frozen.skillPath, path.join(root, ".okf-wiki", "runs", runId, "skill"));
  assert.ok(frozen.skillDigest && frozen.skillDigest.length > 8);
  assert.equal(frozen.sources.length, 1);
  assert.equal(frozen.sources[0]!.id, "main");
  assert.ok(frozen.sources[0]!.revision);
  assert.equal(frozen.sourcePathMap.get("main"), frozen.sources[0]!.path);
  assert.ok(frozen.sourceIgnores.has("main"));
  assert.equal(
    await readFile(path.join(frozen.sourcePathMap.get("main")!, "README.md"), "utf8"),
    "# src\n",
  );
  assert.equal(
    await readFile(path.join(frozen.skillPath, "SKILL.md"), "utf8"),
    "---\nname: test-skill\n---\n# skill\n",
  );
  // No okf.wiki-run/v2 file write on freeze (WikiRuns owns control records).
  await assert.rejects(
    () => lstat(path.join(root, ".okf-wiki", "runs", `${runId}.json`)),
    /ENOENT/,
  );
});

test("freezeRunBoundary rejects dirty source", async () => {
  const { workspace } = await makeWorkspace({ dirty: true });
  await assert.rejects(
    () => freezeRunBoundary({ workspace, runId: "dirty-run" }),
    (err: unknown) => {
      assert.ok(err instanceof FreezeWikiRunError);
      assert.equal(err.code, "source_dirty");
      return true;
    },
  );
});

test("freezeRunBoundary rejects empty sources", async () => {
  const { workspace } = await makeWorkspace({ noSources: true });
  await assert.rejects(
    () => freezeRunBoundary({ workspace, runId: "empty-run" }),
    (err: unknown) => {
      assert.ok(err instanceof FreezeWikiRunError);
      assert.equal(err.code, "no_sources");
      return true;
    },
  );
});

test("freezeRunBoundary materialises a fixed revision instead of exposing the live checkout", async () => {
  const { root, workspace } = await makeWorkspace();
  const liveSource = workspace.sources[0]!.path;
  const frozen = await freezeRunBoundary({
    workspace,
    runId: "snapshot-run",
  });

  const snapshot = frozen.sourcePathMap.get("main");
  assert.ok(snapshot);
  assert.notEqual(snapshot, liveSource);
  assert.equal(snapshot, path.join(root, ".okf-wiki", "runs", frozen.runId, "sources", "main"));
  assert.equal((await lstat(snapshot)).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(snapshot, "README.md"))).isSymbolicLink(), false);

  await writeFile(path.join(liveSource, "README.md"), "# changed after freeze\n", "utf8");
  assert.equal(await readFile(path.join(snapshot, "README.md"), "utf8"), "# src\n");
});

test("freezeRunBoundary physically removes Effective Source Ignores from the snapshot", async () => {
  const { workspace } = await makeWorkspace();
  const liveSource = workspace.sources[0]!.path;
  workspace.sources[0]!.ignore = ["private/**"];
  await mkdir(path.join(liveSource, "node_modules"), { recursive: true });
  await mkdir(path.join(liveSource, "private"), { recursive: true });
  await mkdir(path.join(liveSource, "src"), { recursive: true });
  await writeFile(path.join(liveSource, "node_modules", "dep.js"), "ignored default\n");
  await writeFile(path.join(liveSource, "private", "secret.txt"), "ignored configured\n");
  await writeFile(path.join(liveSource, "src", "keep.ts"), "export const keep = true;\n");
  spawnSync("git", ["add", "-f", "."], { cwd: liveSource, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "tracked ignores"], { cwd: liveSource, stdio: "ignore" });

  const frozen = await freezeRunBoundary({
    workspace,
    runId: "ignore-run",
  });
  const snapshot = frozen.sourcePathMap.get("main")!;

  await assert.rejects(() => readFile(path.join(snapshot, "node_modules", "dep.js")));
  await assert.rejects(() => readFile(path.join(snapshot, "private", "secret.txt")));
  assert.equal(
    await readFile(path.join(snapshot, "src", "keep.ts"), "utf8"),
    "export const keep = true;\n",
  );
  assert.ok(frozen.sources[0]!.effectiveIgnores.includes("private/**"));
});

test("freezeRunBoundary turns Git symlink blobs into read-only ordinary text files", async () => {
  const { workspace } = await makeWorkspace();
  const liveSource = workspace.sources[0]!.path;
  await symlink("README.md", path.join(liveSource, "readme-link"));
  spawnSync("git", ["add", "."], { cwd: liveSource, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "add symlink blob"], { cwd: liveSource, stdio: "ignore" });

  const frozen = await freezeRunBoundary({
    workspace,
    runId: "symlink-run",
  });
  const snapshot = frozen.sourcePathMap.get("main")!;
  const linkInfo = await lstat(path.join(snapshot, "readme-link"));

  assert.equal(linkInfo.isSymbolicLink(), false);
  assert.equal(linkInfo.isFile(), true);
  assert.equal(await readFile(path.join(snapshot, "readme-link"), "utf8"), "README.md");
  assert.equal(linkInfo.mode & 0o222, 0);
  assert.equal((await lstat(snapshot)).mode & 0o222, 0);
});

test("freezeRunBoundary copies and reverifies the Producer Skill as a run-owned version", async () => {
  const { root, workspace, skillDir } = await makeWorkspace();
  const frozen = await freezeRunBoundary({
    workspace,
    runId: "skill-run",
  });

  const expectedPath = path.join(root, ".okf-wiki", "runs", frozen.runId, "skill");
  assert.equal(frozen.skillPath, expectedPath);
  assert.equal((await lstat(frozen.skillPath)).isSymbolicLink(), false);
  assert.equal((await lstat(path.join(frozen.skillPath, "SKILL.md"))).mode & 0o222, 0);
  assert.equal(await skillDigest(frozen.skillPath), frozen.skillDigest);

  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: changed\n---\n# changed\n");
  assert.equal(await skillDigest(frozen.skillPath), frozen.skillDigest);
});

test("freezeRunBoundary refuses an existing run directory without touching its contents", async () => {
  const { root, workspace } = await makeWorkspace();
  const collisionId = "collision-run";
  const existing = path.join(root, ".okf-wiki", "runs", collisionId);
  await mkdir(existing, { recursive: true });
  await writeFile(path.join(existing, "sentinel.txt"), "operator data\n");

  await assert.rejects(
    () =>
      freezeRunBoundary({
        workspace,
        runId: collisionId,
      }),
    /already exists/i,
  );
  assert.equal(await readFile(path.join(existing, "sentinel.txt"), "utf8"), "operator data\n");
});

test("freezeRunBoundary removes only its new run directory when later freeze steps fail", async () => {
  const { root, workspace, skillDir } = await makeWorkspace();
  const forcedId = "bad-skill-run";
  // Pre-create the exclusive run dir so freeze fails on EEXIST after mkdir attempt.
  const runDir = path.join(root, ".okf-wiki", "runs", forcedId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "sentinel.txt"), "pre-existing\n");

  await assert.rejects(
    () =>
      freezeRunBoundary({
        workspace,
        runId: forcedId,
      }),
    /already exists/i,
  );

  // Pre-existing directory is untouched (freeze does not own it).
  assert.equal(await readFile(path.join(runDir, "sentinel.txt"), "utf8"), "pre-existing\n");
  assert.equal(
    await readFile(path.join(skillDir, "SKILL.md"), "utf8"),
    "---\nname: test-skill\n---\n# skill\n",
  );
});
