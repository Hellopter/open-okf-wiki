import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { freezeRun } from "../scripts/lib/freeze.mjs";
import { gcWorkspace, selectRunsToKeep } from "../scripts/lib/gc.mjs";
import { objectPath, objectsDir } from "../scripts/lib/paths.mjs";
import { addPathSource } from "../scripts/lib/sources.mjs";
import { initWorkspace } from "../scripts/lib/workspace.mjs";
import { installAll } from "../scripts/lib/install.mjs";
import { readJson } from "../scripts/lib/artifacts.mjs";
import { setActiveRun } from "../scripts/lib/active-run.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OW = path.resolve(__dirname, "../scripts/ow.mjs");

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

function makeWorkspace(label = "a") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gc-"));
  const source = path.join(root, "source");
  writeTree(source, {
    "src/app.js": `export const label = ${JSON.stringify(label)};\n`,
    "target/ignored.class": "ignored\n",
  });
  const workspace = path.join(root, "workspace");
  initWorkspace(workspace, { name: "gc-demo", wikiLanguage: "en" });
  installAll(workspace, { force: true });
  addPathSource(workspace, { linkedPath: source, id: "app" });
  return { root, source, workspace };
}

function countObjects(workspace) {
  const base = path.join(objectsDir(workspace), "sha256");
  if (!fs.existsSync(base)) return 0;
  let n = 0;
  for (const shard of fs.readdirSync(base)) {
    const dir = path.join(base, shard);
    if (!fs.statSync(dir).isDirectory()) continue;
    n += fs.readdirSync(dir).filter((name) => !name.startsWith(".tmp-")).length;
  }
  return n;
}

describe("selectRunsToKeep", () => {
  it("always protects current and fills newest up to keepRuns", () => {
    const metas = [
      { runId: "old", createdAt: "2020-01-01T00:00:00.000Z" },
      { runId: "mid", createdAt: "2021-01-01T00:00:00.000Z" },
      { runId: "new", createdAt: "2022-01-01T00:00:00.000Z" },
    ];
    const keep = selectRunsToKeep(metas, "old", 2);
    assert.ok(keep.has("old"));
    assert.ok(keep.has("new"));
    assert.equal(keep.size, 2);
  });

  it("keepRuns 0 keeps only current", () => {
    const metas = [
      { runId: "a", createdAt: "2022-01-01T00:00:00.000Z" },
      { runId: "b", createdAt: "2023-01-01T00:00:00.000Z" },
    ];
    const keep = selectRunsToKeep(metas, "a", 0);
    assert.deepEqual([...keep], ["a"]);
  });
});

describe("gcWorkspace", () => {
  it("protects the active run and reclaims older runs + unreferenced objects", () => {
    const { workspace, source } = makeWorkspace("v1");
    const first = freezeRun(workspace, { focus: "one" });
    // Change source content so the next freeze creates a distinct object.
    fs.writeFileSync(path.join(source, "src", "app.js"), 'export const label = "v2";\n');
    const second = freezeRun(workspace, { focus: "two" });
    assert.notEqual(first.runId, second.runId);
    assert.ok(countObjects(workspace) >= 2);

    const dry = gcWorkspace(workspace, { keepRuns: 1, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.deletedRuns.includes(first.runId));
    assert.ok(dry.keptRuns.includes(second.runId));
    assert.ok(fs.existsSync(first.runDir));
    assert.ok(countObjects(workspace) >= 2);

    const live = gcWorkspace(workspace, { keepRuns: 1, dryRun: false });
    assert.ok(live.deletedRuns.includes(first.runId));
    assert.ok(!fs.existsSync(first.runDir));
    assert.ok(fs.existsSync(second.runDir));
    assert.ok(live.objectsDeleted >= 1);
    // Second run's objects remain.
    const snap = readJson(path.join(second.workdir, "inputs", "snapshot-manifest.json"));
    for (const file of snap.sources[0].files) {
      assert.ok(fs.existsSync(objectPath(workspace, file.sha256)));
    }
  });

  it("does not delete the current pointer run even when keepRuns is 0", () => {
    const { workspace } = makeWorkspace("only");
    const run = freezeRun(workspace);
    setActiveRun(workspace, {
      runId: run.runId,
      workdir: run.workdir,
      phase: "frozen",
      status: "active",
    });
    const result = gcWorkspace(workspace, { keepRuns: 0 });
    assert.ok(result.keptRuns.includes(run.runId));
    assert.ok(fs.existsSync(run.runDir));
    assert.equal(result.deletedRuns.includes(run.runId), false);
  });

  it("ow gc CLI returns JSON summary", () => {
    const { workspace } = makeWorkspace("cli");
    freezeRun(workspace, { focus: "a" });
    freezeRun(workspace, { focus: "b" });
    freezeRun(workspace, { focus: "c" });
    freezeRun(workspace, { focus: "d" });
    const result = spawnSync(
      process.execPath,
      [OW, "gc", "--keep-runs", "1", "--workspace", workspace],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.ok(summary.deletedRuns.length >= 2);
    assert.ok(summary.keptRuns.length >= 1);
  });
});
