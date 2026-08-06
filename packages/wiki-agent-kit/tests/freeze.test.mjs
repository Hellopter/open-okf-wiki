import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { freezeRun } from "../scripts/lib/freeze.mjs";
import { ensureObjectFromBuffer, objectPath, placeObject } from "../scripts/lib/objects.mjs";
import { objectsDir } from "../scripts/lib/paths.mjs";
import { addPathSource } from "../scripts/lib/sources.mjs";
import { initWorkspace } from "../scripts/lib/workspace.mjs";
import { installAll } from "../scripts/lib/install.mjs";
import { readJson } from "../scripts/lib/artifacts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OW = path.resolve(__dirname, "../scripts/ow.mjs");

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
  installAll(workspace, { force: true });
  addPathSource(workspace, { linkedPath: source, id: "app" });
  return { root, source, workspace };
}

function isHardlinked(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0;
  } catch {
    return false;
  }
}

describe("CAS freeze materialization", () => {
  it("keeps non-ignored files, drops defaults, and records placement", () => {
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
    assert.ok(snapshot.sources[0].placement);
    assert.equal(
      snapshot.sources[0].placement.hardlinked + snapshot.sources[0].placement.copied,
      snapshot.sources[0].fileCount,
    );
    assert.ok(first.meta.placement);
    assert.ok(fs.existsSync(objectsDir(workspace)));
  });

  it("reuses CAS objects across freezes and keeps contentDigest stable", () => {
    const { workspace } = makeWorkspace();
    const a = freezeRun(workspace, { focus: "first" });
    const b = freezeRun(workspace, { focus: "second" });
    assert.notEqual(a.runId, b.runId);

    const snapA = readJson(path.join(a.workdir, "inputs", "snapshot-manifest.json"));
    const snapB = readJson(path.join(b.workdir, "inputs", "snapshot-manifest.json"));
    assert.equal(snapA.sources[0].contentDigest, snapB.sources[0].contentDigest);

    // Second freeze should mostly reuse objects.
    assert.ok(snapB.sources[0].placement.objectsReused >= 1);
    assert.equal(snapB.sources[0].placement.objectsCreated, 0);

    const destA = path.join(a.workdir, "sources", "app", "src", "app.js");
    const destB = path.join(b.workdir, "sources", "app", "src", "app.js");
    const digest = snapA.sources[0].files.find((f) => f.path === "src/app.js").sha256;
    const objectAbs = objectPath(workspace, digest);
    assert.ok(fs.existsSync(objectAbs));
    // Prefer hardlink when the FS allows it; otherwise accept copy.
    if (isHardlinked(objectAbs, destA)) {
      assert.ok(isHardlinked(objectAbs, destB));
      assert.ok(snapA.sources[0].placement.hardlinked >= 1);
    } else {
      assert.ok(snapA.sources[0].placement.copied >= 1);
    }
    assert.equal(fs.readFileSync(destA, "utf8"), fs.readFileSync(destB, "utf8"));
  });

  it("marks CAS objects readonly after create", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-obj-"));
    const { path: objectAbs, created } = ensureObjectFromBuffer(root, Buffer.from("hello-cas\n"));
    assert.equal(created, true);
    const mode = fs.statSync(objectAbs).mode & 0o222;
    // Best-effort: on Unix write bits should be clear.
    if (process.platform !== "win32") {
      assert.equal(mode, 0);
    }
    const again = ensureObjectFromBuffer(root, Buffer.from("hello-cas\n"));
    assert.equal(again.created, false);
    assert.equal(again.path, objectAbs);
  });

  it("falls back to copy when hardlink fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-place-"));
    const { path: objectAbs } = ensureObjectFromBuffer(root, Buffer.from("payload\n"));
    const dest = path.join(root, "out", "file.txt");
    const originalLink = fs.linkSync;
    let forced = false;
    fs.linkSync = () => {
      forced = true;
      const err = new Error("cross-device");
      err.code = "EXDEV";
      throw err;
    };
    try {
      const method = placeObject(objectAbs, dest);
      assert.equal(method, "copy");
      assert.equal(forced, true);
      assert.equal(fs.readFileSync(dest, "utf8"), "payload\n");
      assert.equal(isHardlinked(objectAbs, dest), false);
    } finally {
      fs.linkSync = originalLink;
    }
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
    installAll(workspace, { force: true });
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
});

describe("ow prepare smoke with CAS", () => {
  it("prepare creates objects and placement stats", () => {
    const { workspace } = makeWorkspace();
    const result = spawnSync(process.execPath, [OW, "prepare", "--mode", "auto", "--workspace", workspace], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const prepared = JSON.parse(result.stdout);
    const snapshot = readJson(path.join(prepared.workdir, "inputs", "snapshot-manifest.json"));
    assert.ok(snapshot.sources[0].placement);
    assert.ok(fs.readdirSync(path.join(objectsDir(workspace), "sha256")).length >= 1);
  });
});
