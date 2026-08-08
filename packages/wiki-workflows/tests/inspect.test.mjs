import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWiki } from "../dist/inspect.js";

const temporaryDirectories = [];

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function createRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-inspect-"));
  temporaryDirectories.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "wiki@example.test");
  git(root, "config", "user.name", "Wiki Test");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "src", "service.ts"), "export const service = 1;\n");
  await writeFile(path.join(root, "src", "utility.ts"), "export const utility = true;\n");
  await writeFile(path.join(root, "wiki", "concepts", "service.md"), [
    "---",
    "type: concept",
    "title: Service",
    "description: Service implementation",
    "sources:",
    "  - src/service.ts#L1-L1",
    "---",
    "",
    "# Service",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "wiki", "concepts", "consumer.md"), [
    "---",
    "type: concept",
    "title: Consumer",
    "description: Uses Service",
    "sources:",
    "  - src/consumer.ts#L1-L1",
    "---",
    "",
    "# Consumer",
    "",
    "See [Service](./service.md).",
    "",
  ].join("\n"));
  await writeFile(path.join(root, "src", "consumer.ts"), "export const consumer = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Generate wiki");
  return root;
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("uses the Wiki commit merge-base and propagates source impact through inbound links", async () => {
  const root = await createRepository();
  const wikiCommit = git(root, "rev-parse", "HEAD");
  await writeFile(path.join(root, "src", "service.ts"), "export const service = 2;\n");
  git(root, "add", "src/service.ts");
  git(root, "commit", "--quiet", "-m", "Change service");
  git(root, "mv", "src/utility.ts", "src/utility-renamed.ts");
  await writeFile(path.join(root, "src", "local.ts"), "export const local = true;\n");
  await writeFile(path.join(root, "src", "untracked.ts"), "export const untracked = true;\n");

  const inspection = await inspectWiki(path.join(root, "src"));

  assert.equal(inspection.root, root);
  assert.equal(inspection.mode, "refresh");
  assert.equal(inspection.lastWikiCommit, wikiCommit);
  assert.equal(inspection.baseCommit, wikiCommit);
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
  assert.deepEqual(inspection.changedPaths, ["src/local.ts", "src/service.ts", "src/untracked.ts", "src/utility-renamed.ts", "src/utility.ts"]);
  assert.ok(inspection.changed.some((change) => change.status.startsWith("R") && change.paths.includes("src/utility.ts") && change.paths.includes("src/utility-renamed.ts")));
  assert.ok(inspection.changed.some((change) => change.status === "??" && change.paths[0] === "src/untracked.ts"));
  assert.equal(inspection.wikiDrift, false);
});

test("falls back to a full generation when the Wiki working tree drifts", async () => {
  const root = await createRepository();
  await writeFile(path.join(root, "wiki", "concepts", "service.md"), "manual edit\n");

  const inspection = await inspectWiki(root);

  assert.equal(inspection.wikiDrift, true);
  assert.equal(inspection.mode, "generate");
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
  assert.deepEqual(inspection.changedPaths, []);
});

test("falls back to a full generation for source provenance without a line range", async () => {
  const root = await createRepository();
  await writeFile(path.join(root, "wiki", "concepts", "service.md"), [
    "---",
    "type: concept",
    "title: Service",
    "description: Service implementation",
    "sources:",
    "  - src/service.ts",
    "---",
    "",
  ].join("\n"));
  git(root, "add", "wiki/concepts/service.md");
  git(root, "commit", "--quiet", "-m", "Invalid wiki provenance");

  const inspection = await inspectWiki(root);

  assert.equal(inspection.wikiDrift, false);
  assert.equal(inspection.mode, "generate");
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
});

test("falls back to a full generation when a source is missing or resolves outside the workspace", async () => {
  const root = await createRepository();
  const outside = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-inspect-outside-"));
  temporaryDirectories.push(outside);
  await writeFile(path.join(outside, "external.ts"), "export const external = true;\n");
  await symlink(path.join(outside, "external.ts"), path.join(root, "src", "external.ts"), "file");
  await writeFile(path.join(root, "wiki", "concepts", "service.md"), [
    "---",
    "type: concept",
    "title: Service",
    "description: Service implementation",
    "sources:",
    "  - src/external.ts#L1-L1",
    "  - src/missing.ts#L1-L1",
    "---",
    "",
  ].join("\n"));
  git(root, "add", "wiki/concepts/service.md", "src/external.ts");
  git(root, "commit", "--quiet", "-m", "Unsafe source provenance");

  const inspection = await inspectWiki(root);

  assert.equal(inspection.wikiDrift, false);
  assert.equal(inspection.mode, "generate");
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
});
