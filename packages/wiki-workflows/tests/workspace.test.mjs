import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  addWikiSource,
  directoryLinkType,
  initializeWikiWorkspace,
  loadWikiWorkspace,
  sourceIsIgnored,
} from "../dist/workspace.js";

const temporaryDirectories = [];

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function repository(parent, name) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "wiki@example.test");
  git(root, "config", "user.name", "Wiki Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Initial source");
  return root;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

test("initializes a plain YAML workspace and persists its language", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-workspace-"));
  temporaryDirectories.push(parent);
  const first = await initializeWikiWorkspace({ cwd: parent, workspace: "docs", language: "en" });
  const root = path.join(parent, "docs");

  assert.deepEqual(first, { action: "initialized", workspace: root, language: "en" });
  await assert.rejects(lstat(path.join(root, ".git")), { code: "ENOENT" }, "init must not create a workspace Git repository");
  assert.deepEqual(YAML.parse(await readFile(path.join(root, "workspace.yaml"), "utf8")), {
    version: 1,
    language: "en",
    defaultSourceIgnores: true,
    sources: [],
  });
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), ".okf-wiki/\n");

  await initializeWikiWorkspace({ cwd: root, language: "zh" });
  assert.equal((await loadWikiWorkspace(root)).language, "zh");
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), ".okf-wiki/\n");
});

test("links a Git source by its project directory name without an alias", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-workspace-link-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "api");
  const workspace = path.join(parent, "docs");
  await initializeWikiWorkspace({ cwd: workspace, language: "zh" });

  const result = await addWikiSource({ cwd: parent, workspace: "docs", source: { kind: "link", path: source } });
  assert.deepEqual(result, { action: "linked", workspace, language: "zh", sourcePath: "api" });
  assert.ok((await lstat(path.join(workspace, "api"))).isSymbolicLink());

  const loaded = await loadWikiWorkspace(workspace);
  assert.equal(loaded.sources.length, 1);
  assert.equal(loaded.sources[0].path, "api");
  assert.equal(loaded.sources[0].realPath, source);
  assert.equal(sourceIsIgnored(loaded.sources[0], "node_modules/pkg/index.js", true), true);
  assert.equal(sourceIsIgnored(loaded.sources[0], "src/cache.pyc", true), true);
  assert.equal(sourceIsIgnored(loaded.sources[0], "node_modules/pkg/index.js", false), false);
  assert.equal(sourceIsIgnored(loaded.sources[0], "src/index.ts", true), false);
  await assert.rejects(() => addWikiSource({ cwd: parent, workspace: "docs", source: { kind: "link", path: source } }), /workspace entry already exists/);
});

test("clones a Git source into the workspace root and records its optional ref", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-workspace-clone-"));
  temporaryDirectories.push(parent);
  const source = await repository(parent, "web");
  const ref = git(source, "branch", "--show-current");
  const workspace = path.join(parent, "docs");
  await initializeWikiWorkspace({ cwd: workspace });

  const result = await addWikiSource({ cwd: workspace, source: { kind: "clone", url: source, ref } });
  assert.deepEqual(result, { action: "cloned", workspace, language: "zh", sourcePath: "web" });
  const loaded = await loadWikiWorkspace(workspace);
  assert.deepEqual(loaded.sources.map((entry) => ({ path: entry.path, origin: entry.origin })), [{
    path: "web",
    origin: { type: "clone", remoteUrl: source, ref },
  }]);
});

test("uses directory links on POSIX and junctions on Windows", () => {
  assert.equal(directoryLinkType("linux"), "dir");
  assert.equal(directoryLinkType("win32"), "junction");
});

test("rejects a workspace as its own source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-workspace-self-"));
  temporaryDirectories.push(root);
  git(root, "init", "--quiet");
  await initializeWikiWorkspace({ cwd: root });

  await assert.rejects(
    () => addWikiSource({ cwd: root, source: { kind: "link", path: root } }),
    /cannot be its own source/,
  );
});
