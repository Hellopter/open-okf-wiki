import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertAbsolutePath, resolveExistingDir } from "./paths.js";
import { listRecentWorkspaces, registerWorkspaceInAppIndex } from "./workspace-app-state.js";
import {
  acquireWikiRunsControlStoreLease,
  createWorkspace,
  loadWorkspace,
  mutateWorkspace,
  parseResetWikiRunsControlStoreArgs,
  resetWikiRunsControlStore,
  saveWorkspace,
  WIKI_RUNS_CONTROL_STORE_FILE_NAME,
  WikiRunsControlStoreInUseError,
  WorkspaceRevisionConflictError,
  workspaceConfigPath,
} from "./workspace-config.js";
import { addSource, updateSource } from "./workspace-source.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function initGitRepo(root: string): Promise<void> {
  const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# test\n");
  const add = spawnSync("git", ["add", "README.md"], { cwd: root, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const commit = spawnSync("git", ["commit", "-m", "init"], { cwd: root, encoding: "utf8" });
  assert.equal(commit.status, 0, commit.stderr);
}

test("resolveExistingDir rejects empty paths", async () => {
  await assert.rejects(() => resolveExistingDir(""), /non-empty/);
  await assert.rejects(() => resolveExistingDir("   "), /non-empty/);
});

test("resolveExistingDir rejects missing and non-directory paths", async () => {
  const root = await tempDir("okf-wiki-path-");
  await assert.rejects(() => resolveExistingDir(path.join(root, "missing")), /does not exist/);

  const filePath = path.join(root, "file.txt");
  await writeFile(filePath, "x\n");
  await assert.rejects(() => resolveExistingDir(filePath), /not a directory/);
});

test("resolveExistingDir returns absolute existing directory", async () => {
  const root = await tempDir("okf-wiki-path-ok-");
  const resolved = await resolveExistingDir(root);
  assert.equal(resolved, path.resolve(root));
});

test("create/load/save workspace roundtrip", async () => {
  const root = await tempDir("okf-wiki-ws-");
  const sourceRoot = await tempDir("okf-wiki-src-");
  await initGitRepo(sourceRoot);

  let config = await createWorkspace({
    name: "Demo Workspace",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    modelProfileId: "corp-profile",
    resolvedModelId: "openai/corp-model",
  });

  assert.equal(config.name, "Demo Workspace");
  assert.equal(config.rootPath, path.resolve(root));
  assert.equal(config.publicationPath, path.join(path.resolve(root), "wiki"));
  assert.equal(config.version, 3);
  assert.equal(config.revision, 0);
  assert.equal(config.model.id, "openai/corp-model");
  assert.equal(config.model.profileId, "corp-profile");
  assert.equal(config.sources.length, 0);
  assert.ok(config.id.length > 0);
  assert.ok(config.createdAt);

  const added = await addSource(config, { id: "application", path: sourceRoot });
  config = added.config;
  assert.equal(added.probe.isGit, true);
  assert.equal(added.probe.dirty, false);
  assert.equal(config.sources.length, 1);
  assert.equal(config.sources[0]?.id, "application");
  assert.equal(config.sources[0]?.path, path.resolve(sourceRoot));
  assert.deepEqual(config.sources[0]?.origin, { type: "path" });

  await saveWorkspace(config);

  const onDisk = await readFile(workspaceConfigPath(root), "utf8");
  assert.match(onDisk, /"version": 3/);
  assert.doesNotMatch(onDisk, /api[_-]?key/i);

  const loaded = await loadWorkspace(root);
  assert.equal(loaded.id, config.id);
  assert.equal(loaded.name, config.name);
  assert.equal(loaded.rootPath, config.rootPath);
  assert.equal(loaded.publicationPath, config.publicationPath);
  assert.equal(loaded.model.id, "openai/corp-model");
  assert.deepEqual(loaded.sources, config.sources);
  assert.equal(loaded.orchestration.maxDomainFanOut, 4);
  assert.deepEqual(loaded.roleModels.reviewers, []);
  assert.equal(loaded.revision, 0);
});

test("loadWorkspace reads legacy v3 documents as revision zero", async () => {
  const root = await tempDir("okf-wiki-ws-legacy-revision-");
  const config = await createWorkspace({
    name: "Legacy revision",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  const { revision: _revision, ...legacy } = config;
  await writeFile(workspaceConfigPath(root), `${JSON.stringify(legacy)}\n`, "utf8");

  const loaded = await loadWorkspace(root);
  assert.equal(loaded.revision, 0);

  const updated = await mutateWorkspace(root, 0, (workspace) => ({
    ...workspace,
    name: "Persisted revision",
  }));
  assert.equal(updated.revision, 1);
  assert.equal((await loadWorkspace(root)).revision, 1);
});

test("mutateWorkspace serializes one config path and rejects stale revisions", async () => {
  const root = await tempDir("okf-wiki-ws-mutate-");
  const config = await createWorkspace({
    name: "Original",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(config);

  let releaseFirst: (() => void) | undefined;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered: (() => void) | undefined;
  const firstEnteredPromise = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  const first = mutateWorkspace(root, 0, async (workspace) => {
    firstEntered?.();
    await firstReleased;
    return { ...workspace, name: "First" };
  });
  await firstEnteredPromise;
  const stale = mutateWorkspace(root, 0, (workspace) => ({
    ...workspace,
    name: "Stale",
  }));
  releaseFirst?.();

  const saved = await first;
  assert.equal(saved.revision, 1);
  await assert.rejects(
    () => stale,
    (error: unknown) =>
      error instanceof WorkspaceRevisionConflictError &&
      error.expectedRevision === 0 &&
      error.current.revision === 1,
  );
  const final = await loadWorkspace(root);
  assert.equal(final.name, "First");
  assert.equal(final.revision, 1);
});

test("saveWorkspace protects legacy read-modify-write callers with revision CAS", async () => {
  const root = await tempDir("okf-wiki-ws-save-cas-");
  const config = await createWorkspace({
    name: "Original",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(config);
  const firstRead = await loadWorkspace(root);
  const secondRead = await loadWorkspace(root);

  await saveWorkspace({ ...firstRead, name: "First writer" });
  await assert.rejects(
    () => saveWorkspace({ ...secondRead, name: "Stale writer" }),
    WorkspaceRevisionConflictError,
  );
  const final = await loadWorkspace(root);
  assert.equal(final.name, "First writer");
  assert.equal(final.revision, 1);
});

test("resetWikiRunsControlStore removes only explicit durable Run state", async () => {
  const root = await tempDir("okf-wiki-ws-reset-control-");
  const config = await createWorkspace({
    name: "Reset control",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(config);

  const meta = path.join(root, ".okf-wiki");
  const control = path.join(meta, WIKI_RUNS_CONTROL_STORE_FILE_NAME);
  await writeFile(control, "control");
  await writeFile(`${control}-wal`, "wal");
  await writeFile(`${control}-shm`, "shm");
  await mkdir(path.join(meta, "runs", "run-1", "artifacts"), { recursive: true });
  await writeFile(path.join(meta, "runs", "run-1", "artifacts", "sealed.txt"), "sealed");
  await mkdir(path.join(meta, "pi-sessions"), { recursive: true });
  const piSession = path.join(meta, "pi-sessions", "session.jsonl");
  await writeFile(piSession, '{"role":"user"}\n');
  const unrelated = path.join(meta, "keep.txt");
  await writeFile(unrelated, "keep");

  const result = await resetWikiRunsControlStore(root);
  assert.deepEqual(result.removed, [
    "workflow.sqlite",
    "workflow.sqlite-wal",
    "workflow.sqlite-shm",
    "runs",
  ]);
  assert.equal((await loadWorkspace(root)).id, config.id);
  assert.equal(await readFile(piSession, "utf8"), '{"role":"user"}\n');
  assert.equal(await readFile(unrelated, "utf8"), "keep");
  await assert.rejects(() => access(control));
  await assert.rejects(() => access(path.join(meta, "runs")));
});

test("resetWikiRunsControlStore rejects while a WikiRuns owner holds its lease", async () => {
  const root = await tempDir("okf-wiki-ws-reset-lease-");
  const config = await createWorkspace({
    name: "Reset lease",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(config);
  const lease = await acquireWikiRunsControlStoreLease(root);

  await assert.rejects(
    () => resetWikiRunsControlStore(root),
    (error: unknown) => error instanceof WikiRunsControlStoreInUseError,
  );

  await lease.release();
  await resetWikiRunsControlStore(root);
});

test("reset control store CLI parser requires an absolute target and confirmation", () => {
  const root = path.resolve("/tmp/okf-wiki-reset-cli");
  assert.deepEqual(parseResetWikiRunsControlStoreArgs(["--workspace", root, "--yes"]), {
    rootPath: root,
  });
  assert.deepEqual(parseResetWikiRunsControlStoreArgs(["--", "--workspace", root, "--yes"]), {
    rootPath: root,
  });
  assert.throws(() => parseResetWikiRunsControlStoreArgs(["--workspace", root]), /requires --yes/);
  assert.throws(
    () => parseResetWikiRunsControlStoreArgs(["--workspace", "relative", "--yes"]),
    /absolute/,
  );
  assert.throws(
    () => parseResetWikiRunsControlStoreArgs(["--workspace", root, "--yes", "--force"]),
    /unknown/,
  );
});

test("reset-control-store command removes only the requested Workspace control state", async () => {
  const root = await tempDir("okf-wiki-ws-reset-cli-command-");
  const config = await createWorkspace({
    name: "Reset command",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(config);
  const control = path.join(root, ".okf-wiki", WIKI_RUNS_CONTROL_STORE_FILE_NAME);
  await writeFile(control, "control");

  const command = path.resolve(process.cwd(), "../../scripts/reset-control-store.mjs");
  const result = spawnSync(process.execPath, [command, "--workspace", root, "--yes"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reset WikiRuns control store/);
  await assert.rejects(() => access(control));
  assert.equal((await loadWorkspace(root)).id, config.id);
});

test("saveWorkspace allows empty sources (draft workspace)", async () => {
  const root = await tempDir("okf-wiki-ws-draft-");
  const config = await createWorkspace({
    name: "Empty",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(config);
  const loaded = await loadWorkspace(root);
  assert.equal(loaded.sources.length, 0);
  assert.equal(loaded.name, "Empty");
});

test("loadWorkspace rejects missing and invalid files", async () => {
  const root = await tempDir("okf-wiki-ws-load-");
  await assert.rejects(() => loadWorkspace(root), /workspace config not found/);

  const okfDir = path.join(root, ".okf-wiki");
  await mkdir(okfDir, { recursive: true });
  await writeFile(path.join(okfDir, "workspace.json"), "{not-json", "utf8");
  await assert.rejects(() => loadWorkspace(root), /invalid workspace JSON/);

  await writeFile(
    path.join(okfDir, "workspace.json"),
    JSON.stringify({ version: 1, name: "nope" }),
    "utf8",
  );
  await assert.rejects(() => loadWorkspace(root), /invalid workspace config/);
});

test("loadWorkspace rejects historical sources without origin", async () => {
  const root = await tempDir("okf-wiki-ws-legacy-origin-");
  const sourceRoot = await tempDir("okf-wiki-src-legacy-");
  await initGitRepo(sourceRoot);
  const okfDir = path.join(root, ".okf-wiki");
  await mkdir(okfDir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    path.join(okfDir, "workspace.json"),
    JSON.stringify({
      version: 2,
      id: "legacy-ws",
      name: "Legacy",
      rootPath: root,
      orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
      sources: [{ id: "application", path: sourceRoot }],
      model: { id: "openai/corp-model" },
      publicationPath: path.join(root, "wiki"),
      createdAt: now,
    }),
    "utf8",
  );

  await assert.rejects(() => loadWorkspace(root), /invalid workspace config/);
});

test("addSource fails for non-git and dirty when requireClean", async () => {
  const root = await tempDir("okf-wiki-ws-src-");
  const plain = await tempDir("okf-wiki-nogit-");
  const dirtyRepo = await tempDir("okf-wiki-dirty-");
  await initGitRepo(dirtyRepo);
  await writeFile(path.join(dirtyRepo, "dirty.txt"), "x\n");

  const config = await createWorkspace({
    name: "Src",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });

  await assert.rejects(
    () => addSource(config, { id: "application", path: plain }),
    /not a git|working tree/i,
  );

  await assert.rejects(() => addSource(config, { id: "application", path: dirtyRepo }), /dirty/i);

  const allowed = await addSource(
    config,
    { id: "application", path: dirtyRepo },
    { requireClean: false },
  );
  assert.equal(allowed.probe.dirty, true);
  assert.equal(allowed.config.sources.length, 1);
});

test("addSource rejects duplicate source ids", async () => {
  const root = await tempDir("okf-wiki-ws-dup-");
  const sourceRoot = await tempDir("okf-wiki-src-dup-");
  await initGitRepo(sourceRoot);

  const config = await createWorkspace({
    name: "Dup",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  const first = await addSource(config, { id: "application", path: sourceRoot });
  await assert.rejects(
    () => addSource(first.config, { id: "application", path: sourceRoot }),
    /already exists/,
  );
});

test("registerWorkspaceInAppIndex and listRecentWorkspaces", async () => {
  const home = await tempDir("okf-wiki-app-");
  const appStatePath = path.join(home, "app.json");
  const a = path.join(home, "ws-a");
  const b = path.join(home, "ws-b");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });

  await registerWorkspaceInAppIndex(a, appStatePath);
  await registerWorkspaceInAppIndex(b, appStatePath);
  // Re-register a — should move to front and dedupe
  await registerWorkspaceInAppIndex(a, appStatePath);

  const recent = await listRecentWorkspaces(appStatePath);
  assert.deepEqual(recent, [path.resolve(a), path.resolve(b)]);

  const emptyHome = await tempDir("okf-wiki-app-empty-");
  const emptyList = await listRecentWorkspaces(path.join(emptyHome, "missing-app.json"));
  assert.deepEqual(emptyList, []);
});

test("createWorkspace rejects existing workspace.json", async () => {
  const root = await tempDir("okf-wiki-ws-exists-");
  const first = await createWorkspace({
    name: "One",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(first);
  await assert.rejects(
    () =>
      createWorkspace({
        name: "Two",
        rootPath: root,
        orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
      }),
    /already exists/,
  );
});

test("createWorkspace honors custom publicationPath", async () => {
  const root = await tempDir("okf-wiki-ws-pub-");
  const publicationPath = path.join(root, "custom-wiki");
  const config = await createWorkspace({
    name: "Pub",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    publicationPath,
  });
  assert.equal(config.publicationPath, path.resolve(publicationPath));
  await resolveExistingDir(publicationPath);
});

test("assertAbsolutePath rejects relative and empty paths", () => {
  assert.throws(() => assertAbsolutePath("", "rootPath"), /non-empty/);
  assert.throws(() => assertAbsolutePath("   ", "rootPath"), /non-empty/);
  assert.throws(() => assertAbsolutePath("relative/path", "rootPath"), /absolute/);
  assert.throws(() => assertAbsolutePath("./here", "rootPath"), /absolute/);
  const abs = path.resolve("/tmp/okf-abs-test");
  assert.equal(assertAbsolutePath(abs, "rootPath"), abs);
  assert.equal(assertAbsolutePath(`  ${abs}  `, "rootPath"), abs);
});

test("createWorkspace rejects relative rootPath", async () => {
  await assert.rejects(
    () =>
      createWorkspace({
        name: "Rel",
        rootPath: "relative/ws",
        orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
      }),
    /absolute/,
  );
  await assert.rejects(
    () =>
      createWorkspace({
        name: "Rel",
        rootPath: "./relative-ws",
        orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
      }),
    /absolute/,
  );
});

test("createWorkspace rejects relative publicationPath", async () => {
  const root = await tempDir("okf-wiki-ws-rel-pub-");
  await assert.rejects(
    () =>
      createWorkspace({
        name: "RelPub",
        rootPath: root,
        orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
        publicationPath: "relative/wiki",
      }),
    /absolute/,
  );
});

test("createWorkspace treats only ENOENT as missing config", async () => {
  // Happy path: no workspace.json yet → ENOENT from access → create succeeds.
  const root = await tempDir("okf-wiki-ws-enoent-");
  const config = await createWorkspace({
    name: "Enoent",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  assert.equal(config.name, "Enoent");
  assert.equal(config.rootPath, path.resolve(root));
  // After save, access finds the file and createWorkspace must reject.
  await saveWorkspace(config);
  await assert.rejects(
    () =>
      createWorkspace({
        name: "Again",
        rootPath: root,
        orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
      }),
    /already exists/,
  );
});

test("updateSource updates ignore policy", async () => {
  const root = await tempDir("okf-wiki-update-src-");
  const sourceRoot = await tempDir("okf-wiki-src-");
  await initGitRepo(sourceRoot);

  let ws = await createWorkspace({
    name: "UpdateSrc",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  const added = await addSource(ws, { id: "app", path: sourceRoot }, { requireClean: false });
  ws = added.config;
  assert.equal(ws.sources[0]!.applyDefaultIgnores, true);
  assert.deepEqual(ws.sources[0]!.ignore, []);

  ws = updateSource(ws, "app", {
    applyDefaultIgnores: false,
    ignore: ["src/test/**", "**/*Test.java"],
  });
  assert.equal(ws.sources[0]!.applyDefaultIgnores, false);
  assert.deepEqual(ws.sources[0]!.ignore, ["src/test/**", "**/*Test.java"]);
});

test("addSource rejects relative path", async () => {
  const root = await tempDir("okf-wiki-ws-rel-src-");
  const config = await createWorkspace({
    name: "RelSrc",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await assert.rejects(
    () => addSource(config, { id: "application", path: "relative/repo" }),
    /absolute/,
  );
});
