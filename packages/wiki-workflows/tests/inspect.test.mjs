import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectWiki, verifyPinnedSourcePlan, wikiSourceSlug } from "../dist/inspect.js";

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

test("captures the complete declared source identity without exposing a second inspection projection", async () => {
  const { source, workspace } = await createRepository();
  await writeFile(path.join(source, "src", "service.ts"), "export const service = 2;\n");
  git(source, "add", "src/service.ts");
  git(source, "mv", "src/utility.ts", "src/utility-renamed.ts");
  await writeFile(path.join(source, "src", "local.ts"), "export const local = true;\n");
  await writeFile(path.join(source, "src", "untracked.ts"), "export const untracked = true;\n");

  const inspection = await inspectWiki(path.join(workspace, "api", "src"));

  assert.equal(inspection.workspaceRoot, workspace);
  assert.deepEqual(inspection.sources.map((source) => source.scopeId), ["api"]);
  assert.match(inspection.sources[0].dirtyFingerprint, /^[a-f0-9]{64}$/);
  assert.equal("changed" in inspection, false);
  assert.equal("sourceFingerprint" in inspection, false);
});

test("published Wiki content does not affect inspection", async () => {
  const { workspace } = await createRepository();
  const first = await inspectWiki(workspace);
  await writeFile(path.join(workspace, "wiki", "concepts", "service.md"), "completely unrelated old Wiki content\n");
  const second = await inspectWiki(workspace);
  assert.equal(second.fingerprint, first.fingerprint);
});

test("changes the source fingerprint when an already-modified path changes again", async () => {
  const { source, workspace } = await createRepository();
  const sourceFile = path.join(source, "src", "service.ts");
  await writeFile(sourceFile, "export const service = 2;\n");
  const first = await inspectWiki(workspace);
  await writeFile(sourceFile, "export const service = 3;\n");
  const second = await inspectWiki(workspace);

  assert.notEqual(first.fingerprint, second.fingerprint);
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

  assert.equal(inspection.workspaceRoot, root);
  assert.deepEqual(inspection.sources.map((source) => source.scopeId), ["source"]);
  assert.equal(inspection.sources[0].logicalPath, ".");
});

test("wikiSourceSlug is the host-owned Wiki folder for a pinned path", () => {
  assert.equal(wikiSourceSlug(".", ["."]), "source");
  assert.equal(wikiSourceSlug("api", ["api"]), "api");
  assert.equal(wikiSourceSlug("packages/accounting-core", ["packages/accounting-core"]), "accounting-core");
  assert.equal(wikiSourceSlug("a/foo", ["a/foo", "b/foo"]), "a-foo");
  assert.equal(wikiSourceSlug("b/foo", ["a/foo", "b/foo"]), "b-foo");
});

test("pinned source verification ignores later presentation settings but rejects repository replacement", async () => {
  const { source, workspace } = await createRepository();
  const inspection = await inspectWiki(workspace);
  const config = path.join(workspace, "workspace.yaml");
  const original = await import("node:fs/promises").then(({ readFile }) => readFile(config, "utf8"));
  await writeFile(config, original.replace("language: zh", "language: en"));
  await verifyPinnedSourcePlan(inspection);

  await rm(path.join(source, ".git"), { recursive: true, force: true });
  git(source, "init", "--quiet");
  git(source, "config", "user.email", "wiki@example.test");
  git(source, "config", "user.name", "Wiki Test");
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "Replacement at same commit content");
  await assert.rejects(verifyPinnedSourcePlan(inspection), /repository identity changed/);
});
