import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
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

test("loads a Git repository without workspace.yaml as an implicit self source", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-implicit-"));
  temporaryDirectories.push(parent);
  const root = await repository(parent, "self");
  const loaded = await loadWikiWorkspace(path.join(root, "src"));

  assert.equal(loaded.root, root);
  assert.equal(loaded.sources.length, 1);
  assert.equal(loaded.sources[0].path, ".");
  assert.equal(loaded.sources[0].realPath, root);
  assert.equal(sourceIsIgnored(loaded.sources[0], ".okf-wiki/runs/a/run-state.json", true), true);
  assert.equal(sourceIsIgnored(loaded.sources[0], "wiki/overview.md", true), true);
  assert.equal(sourceIsIgnored(loaded.sources[0], "src/index.ts", true), false);
  await assert.rejects(lstat(path.join(root, "workspace.yaml")), { code: "ENOENT" });
});
