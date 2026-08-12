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
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-inspect-"));
  temporaryDirectories.push(parent);
  const source = path.join(parent, "api");
  const workspace = path.join(parent, "docs");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "src", "service.ts"), "export const service = 1;\n");
  await writeFile(path.join(source, "src", "utility.ts"), "export const utility = true;\n");
  await writeFile(path.join(source, "src", "consumer.ts"), "export const consumer = 1;\n");
  git(source, "init", "--quiet");
  git(source, "config", "user.email", "wiki@example.test");
  git(source, "config", "user.name", "Wiki Test");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Initial source");

  await mkdir(workspace, { recursive: true });
  await symlink(source, path.join(workspace, "api"), "dir");
  await writeFile(path.join(workspace, "workspace.yaml"), [
    "version: 1", "language: zh", "defaultSourceIgnores: true", "wiki:", "  exclude: []", "sources:",
    `  - path: api`, "    origin:", "      type: link", `      localPath: ${JSON.stringify(source)}`, "",
  ].join("\n"));
  await mkdir(path.join(workspace, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(workspace, "wiki", "concepts", "service.md"), [
    "---",
    "type: concept",
    "title: Service",
    "description: Service implementation",
    "sources:",
    "  - id: service",
    "    resource: repo:api/src/service.ts#L1-L1",
    "---",
    "",
    "# Service",
    "",
  ].join("\n"));
  await writeFile(path.join(workspace, "wiki", "concepts", "consumer.md"), [
    "---",
    "type: concept",
    "title: Consumer",
    "description: Uses Service",
    "sources:",
    "  - id: consumer",
    "    resource: repo:api/src/consumer.ts#L1-L1",
    "---",
    "",
    "# Consumer",
    "",
    "See [Service](./service.md).",
    "",
  ].join("\n"));
  return { source, workspace };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("uses declared source Git changes and propagates source impact through inbound links", async () => {
  const { source, workspace } = await createRepository();
  await writeFile(path.join(source, "src", "service.ts"), "export const service = 2;\n");
  git(source, "add", "src/service.ts");
  git(source, "mv", "src/utility.ts", "src/utility-renamed.ts");
  await writeFile(path.join(source, "src", "local.ts"), "export const local = true;\n");
  await writeFile(path.join(source, "src", "untracked.ts"), "export const untracked = true;\n");

  const inspection = await inspectWiki(path.join(workspace, "api", "src"));

  assert.equal(inspection.root, workspace);
  assert.deepEqual(inspection.sourcePaths, ["api"]);
  assert.equal(inspection.mode, "refresh");
  assert.equal(inspection.lastWikiCommit, null);
  assert.equal(inspection.baseCommit, null);
  assert.deepEqual(inspection.existingPages, ["concepts/consumer.md", "concepts/service.md"]);
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
  assert.deepEqual(inspection.changedPaths, [
    "api/src/local.ts",
    "api/src/service.ts",
    "api/src/untracked.ts",
    "api/src/utility-renamed.ts",
    "api/src/utility.ts",
  ]);
  assert.ok(inspection.changed.some((change) => change.status.startsWith("R") && change.paths.includes("api/src/utility.ts") && change.paths.includes("api/src/utility-renamed.ts")));
  assert.ok(inspection.changed.some((change) => change.status === "??" && change.paths[0] === "api/src/untracked.ts"));
  assert.equal(inspection.wikiDrift, false);
});

test("uses full generation when there is no trustworthy incremental source range", async () => {
  const { workspace } = await createRepository();
  const inspection = await inspectWiki(workspace);

  assert.equal(inspection.mode, "generate");
  assert.deepEqual(inspection.existingPages, ["concepts/consumer.md", "concepts/service.md"]);
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
});

test("changes the source fingerprint when an already-modified path changes again", async () => {
  const { source, workspace } = await createRepository();
  const sourceFile = path.join(source, "src", "service.ts");
  await writeFile(sourceFile, "export const service = 2;\n");
  const first = await inspectWiki(workspace);
  await writeFile(sourceFile, "export const service = 3;\n");
  const second = await inspectWiki(workspace);

  assert.deepEqual(first.changedPaths, ["api/src/service.ts"]);
  assert.deepEqual(second.changedPaths, ["api/src/service.ts"]);
  assert.equal(first.changed[0].status, second.changed[0].status);
  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
});

test("uses full generation for source provenance without a declared project prefix or line range", async () => {
  const { workspace } = await createRepository();
  await writeFile(path.join(workspace, "wiki", "concepts", "service.md"), [
    "---",
    "type: concept",
    "title: Service",
    "description: Service implementation",
    "sources:",
    "  - src/service.ts",
    "---",
    "",
  ].join("\n"));

  const inspection = await inspectWiki(workspace);

  assert.equal(inspection.mode, "generate");
  assert.match(inspection.refreshRequiresGenerateReason, /legacy source citations/);
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
});

test("uses full generation when a declared source link escapes its Git root", async () => {
  const { source, workspace } = await createRepository();
  const outside = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-inspect-outside-"));
  temporaryDirectories.push(outside);
  await writeFile(path.join(outside, "external.ts"), "export const external = true;\n");
  await symlink(path.join(outside, "external.ts"), path.join(source, "src", "external.ts"), "file");
  await writeFile(path.join(workspace, "wiki", "concepts", "service.md"), [
    "---",
    "type: concept",
    "title: Service",
    "description: Service implementation",
    "sources:",
    "  - api/src/external.ts#L1-L1",
    "  - api/src/missing.ts#L1-L1",
    "---",
    "",
  ].join("\n"));

  const inspection = await inspectWiki(workspace);

  assert.equal(inspection.mode, "generate");
  assert.deepEqual(inspection.impactedPages, ["concepts/consumer.md", "concepts/service.md"]);
});

test("inspects an implicit self repository with stable unprefixed paths and ignores Wiki state", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-inspect-self-"));
  temporaryDirectories.push(parent);
  const root = path.join(parent, "self");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "wiki@example.test");
  git(root, "config", "user.name", "Wiki Test");
  git(root, "add", "src/index.ts");
  git(root, "commit", "--quiet", "-m", "Initial source");
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 2;\n");
  await mkdir(path.join(root, ".okf-wiki", "runs"), { recursive: true });
  await writeFile(path.join(root, ".okf-wiki", "runs", "state.json"), "{}\n");
  await mkdir(path.join(root, "wiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", "overview.md"), "# Existing\n");

  const inspection = await inspectWiki(path.join(root, "src"));

  assert.equal(inspection.root, root);
  assert.deepEqual(inspection.sourcePaths, ["."]);
  assert.deepEqual(inspection.changedPaths, ["src/index.ts"]);
  assert.ok(!inspection.changedPaths.some((entry) => entry.startsWith(".okf-wiki/") || entry.startsWith("wiki/")));
});
