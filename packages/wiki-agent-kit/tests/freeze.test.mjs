import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { freezeRun, verifyFrozenSnapshot } from "../scripts/lib/freeze.mjs";
import { addPathSource, removeSource } from "../scripts/lib/sources.mjs";
import { initWorkspace } from "../scripts/lib/workspace.mjs";
import { installRuntime } from "../scripts/lib/install.mjs";
import { prepareRun } from "../scripts/lib/prepare.mjs";
import { readJson } from "../scripts/lib/artifacts.mjs";

const RUNTIME = {
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: "wiki", digest: `sha256:${"2".repeat(64)}` },
};

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

function makeWorkspace(files = {
  "src/app.js": "export const answer = 42;\n",
  "target/ignored.class": "ignored\n",
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-freeze-"));
  const source = path.join(root, "source");
  writeTree(source, files);
  const workspace = path.join(root, "workspace");
  initWorkspace(workspace, { name: "freeze-demo", wikiLanguage: "en" });
  installRuntime(workspace, RUNTIME);
  addPathSource(workspace, { linkedPath: source, id: "app" });
  return { root, source, workspace };
}

describe("frozen source materialization", () => {
  it("keeps non-ignored files and records a verifiable snapshot", () => {
    const { workspace } = makeWorkspace();
    const first = freezeRun(workspace);
    const frozen = path.join(first.workdir, "sources", "app", "src", "app.js");
    assert.ok(fs.existsSync(frozen));
    assert.ok(!fs.existsSync(path.join(first.workdir, "sources", "app", "target", "ignored.class")));
    assert.ok(fs.existsSync(path.join(first.workdir, "method", "METHOD.md")));
    assert.ok(!fs.existsSync(path.join(first.workdir, "method", "SKILL.md")));

    const snapshot = readJson(path.join(first.workdir, "inputs", "snapshot-manifest.json"));
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.sources.length, 1);
    assert.equal(snapshot.sources[0].sourceId, "app");
    assert.ok(snapshot.sources[0].contentDigest);
    assert.ok(snapshot.sources[0].fileCount >= 1);
    assert.equal(snapshot.sources[0].placement, undefined);
    assert.equal(first.meta.placement, undefined);
    assert.equal(fs.existsSync(path.join(workspace, ".wiki-agent", "objects")), false);
    assert.deepEqual(verifyFrozenSnapshot(first.workdir), { ok: true, errors: [] });
  });

  it("creates independent run copies and detects later mutation", () => {
    const { source, workspace } = makeWorkspace();
    const a = freezeRun(workspace, { focus: "first" });
    const b = freezeRun(workspace, { focus: "second" });
    assert.notEqual(a.runId, b.runId);

    const snapA = readJson(path.join(a.workdir, "inputs", "snapshot-manifest.json"));
    const snapB = readJson(path.join(b.workdir, "inputs", "snapshot-manifest.json"));
    assert.equal(snapA.sources[0].contentDigest, snapB.sources[0].contentDigest);

    const destA = path.join(a.workdir, "sources", "app", "src", "app.js");
    const destB = path.join(b.workdir, "sources", "app", "src", "app.js");
    assert.equal(fs.readFileSync(destA, "utf8"), fs.readFileSync(destB, "utf8"));
    fs.writeFileSync(destA, "mutated frozen copy\n");
    assert.equal(fs.readFileSync(destB, "utf8"), "export const answer = 42;\n");
    assert.equal(fs.readFileSync(path.join(source, "src", "app.js"), "utf8"), "export const answer = 42;\n");
    const verified = verifyFrozenSnapshot(a.workdir);
    assert.equal(verified.ok, false);
    assert.ok(verified.errors.some((error) => /content digest mismatch/i.test(error)));
  });

  it("records skipped symlinks and materializes in-root file symlinks as regular files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-sym-"));
    const source = path.join(root, "source");
    writeTree(source, {
      "src/real.js": "export const x = 1;\n",
    });
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "escape\n");
    try {
      fs.symlinkSync(path.join(source, "src", "real.js"), path.join(source, "src", "link.js"));
      fs.symlinkSync(outside, path.join(source, "escape.txt"));
      fs.symlinkSync(path.join(source, "src"), path.join(source, "src-link"));
    } catch (error) {
      if (error?.code === "EPERM") return; // Windows without symlink privilege
      throw error;
    }

    const workspace = path.join(root, "workspace");
    initWorkspace(workspace, { name: "sym", wikiLanguage: "en" });
    installRuntime(workspace, RUNTIME);
    addPathSource(workspace, { linkedPath: source, id: "app" });
    const frozen = freezeRun(workspace);
    const linkDest = path.join(frozen.workdir, "sources", "app", "src", "link.js");
    assert.ok(fs.existsSync(linkDest));
    assert.equal(fs.lstatSync(linkDest).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(linkDest, "utf8"), "export const x = 1;\n");

    const snapshot = readJson(path.join(frozen.workdir, "inputs", "snapshot-manifest.json"));
    const reasons = snapshot.sources[0].skippedSymlinks.map((s) => s.reason);
    assert.ok(reasons.some((r) => /escape|dangling|directory symlink/i.test(r)));
    assert.ok(!fs.existsSync(path.join(frozen.workdir, "sources", "app", "escape.txt")));
    assert.ok(!fs.existsSync(path.join(frozen.workdir, "sources", "app", "src-link")));
  });

  it("can freeze the workspace itself without ingesting Pi or Wiki runtime output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-same-cwd-"));
    writeTree(root, {
      "src/app.js": "export const app = true;\n",
      ".pi/sessions/current.json": "{}\n",
      ".claude/workflows/old.js": "legacy\n",
    });
    initWorkspace(root, { name: "same-cwd", wikiLanguage: "en" });
    installRuntime(root, RUNTIME);
    addPathSource(root, { linkedPath: root, id: "project" });
    const frozen = freezeRun(root);
    const sourceRoot = path.join(frozen.workdir, "sources", "project");
    assert.ok(fs.existsSync(path.join(sourceRoot, "src", "app.js")));
    assert.equal(fs.existsSync(path.join(sourceRoot, ".wiki-agent")), false);
    assert.equal(fs.existsSync(path.join(sourceRoot, ".pi")), false);
    assert.equal(fs.existsSync(path.join(sourceRoot, ".claude")), false);
  });
});

describe("Pi prepare frozen sources", () => {
  it("prepare creates a snapshot without an object store", () => {
    const { workspace } = makeWorkspace();
    const prepared = prepareRun(workspace, { mode: "auto" });
    const snapshot = readJson(path.join(prepared.workdir, "inputs", "snapshot-manifest.json"));
    assert.equal(snapshot.sources[0].placement, undefined);
    assert.equal(fs.existsSync(path.join(workspace, ".wiki-agent", "objects")), false);
    assert.deepEqual(verifyFrozenSnapshot(prepared.workdir), { ok: true, errors: [] });
  });
});

describe("source removal containment", () => {
  it("rejects traversal-like source ids without touching the workspace", () => {
    const { workspace } = makeWorkspace();
    assert.throws(() => removeSource(workspace, ".."), /invalid source id/i);
    assert.ok(fs.existsSync(path.join(workspace, "workspace.yaml")));
    assert.ok(fs.existsSync(path.join(workspace, "sources", "app")));
  });

  it("refuses to remove when the sources directory resolves outside the workspace", () => {
    const { root, workspace } = makeWorkspace();
    const externalSources = path.join(root, "external-sources");
    fs.mkdirSync(path.join(externalSources, "app"), { recursive: true });
    fs.writeFileSync(path.join(externalSources, "app", "keep.txt"), "must remain\n");
    fs.rmSync(path.join(workspace, "sources"), { recursive: true, force: true });
    try {
      fs.symlinkSync(externalSources, path.join(workspace, "sources"), "dir");
    } catch (error) {
      if (error?.code === "EPERM") return; // Windows without symlink privilege
      throw error;
    }

    assert.throws(() => removeSource(workspace, "app"), /path escapes workspace root/i);
    assert.ok(fs.existsSync(path.join(externalSources, "app", "keep.txt")));
  });

  it("removes a linked source entry without deleting its external target", () => {
    const { source, workspace } = makeWorkspace();
    const result = removeSource(workspace, "app");
    assert.deepEqual(result, { removed: "app" });
    assert.ok(fs.existsSync(source));
    assert.equal(fs.existsSync(path.join(workspace, "sources", "app")), false);
  });
});
