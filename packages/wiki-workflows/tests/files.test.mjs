import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendText, claimText, ensureDirectory, removePath, renamePath, writeFileDurable, writeText } from "../dist/files.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-files-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

test("durable text operations expose their completed persistence phases", async (t) => {
  const root = await fixture(t);
  const phases = [];
  const options = { fault: (phase) => phases.push(phase) };
  const file = path.join(root, "state.txt");

  await writeText(file, "one", options);
  assert.deepEqual(phases.splice(0), ["file_synced", "renamed", "directory_synced"]);
  await appendText(file, " two", options);
  assert.deepEqual(phases.splice(0), ["appended", "directory_synced"]);
  assert.equal(await readFile(file, "utf8"), "one two");

  const claim = path.join(root, "active.json");
  await claimText(claim, "{}", options);
  assert.deepEqual(phases.splice(0), ["claimed", "directory_synced"]);
  await assert.rejects(claimText(claim, "{}"), { code: "EEXIST" });
  await removePath(claim, { ...options, force: true });
  assert.deepEqual(phases.splice(0), ["removed", "directory_synced"]);
});

test("faults between entry mutation and directory sync expose the completed logical operation", async (t) => {
  const root = await fixture(t);
  const failAt = (expected) => ({ fault: (phase) => { if (phase === expected) throw new Error(`fault-${phase}`); } });

  const appended = path.join(root, "events.jsonl");
  await writeFile(appended, "one\n");
  await assert.rejects(appendText(appended, "two\n", failAt("appended")), /fault-appended/);
  assert.equal(await readFile(appended, "utf8"), "one\ntwo\n");

  const marker = path.join(root, "active.json");
  await assert.rejects(claimText(marker, "{}", failAt("claimed")), /fault-claimed/);
  assert.equal(await readFile(marker, "utf8"), "{}");

  await assert.rejects(removePath(marker, { ...failAt("removed"), force: true }), /fault-removed/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });

  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await writeFile(source, "moved");
  await assert.rejects(renamePath(source, target, failAt("renamed")), /fault-renamed/);
  assert.equal(await readFile(target, "utf8"), "moved");
});

test("atomic write keeps the previous value when a fault occurs before rename", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  await assert.rejects(writeText(file, "new", {
    fault: (phase) => { if (phase === "file_synced") throw new Error("fault-before-rename"); },
  }), /fault-before-rename/);
  assert.equal(await readFile(file, "utf8"), "old");
});

test("durable rename syncs a cross-directory move and remove tolerates an absent forced target", async (t) => {
  const root = await fixture(t);
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  await mkdir(left);
  await mkdir(right);
  await writeFile(path.join(left, "value"), "moved");
  const phases = [];
  await renamePath(path.join(left, "value"), path.join(right, "value"), { fault: (phase) => phases.push(phase) });
  assert.deepEqual(phases, ["renamed", "directory_synced"]);
  assert.equal(await readFile(path.join(right, "value"), "utf8"), "moved");
  await removePath(path.join(root, "missing", "value"), { force: true });
});

test("durable directory creation syncs every new parent entry and tolerates concurrent creators", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "one", "two", "three");
  const phases = [];
  await Promise.all([
    ensureDirectory(target, { fault: (phase) => phases.push(phase) }),
    ensureDirectory(target),
  ]);
  assert.equal(phases.filter((phase) => phase === "directory_created").length, 3);
  assert.equal(phases.filter((phase) => phase === "directory_synced").length, 3);

  const faulted = path.join(root, "faulted");
  await assert.rejects(ensureDirectory(faulted, {
    fault: (phase) => { if (phase === "directory_created") throw new Error("fault-directory-created"); },
  }), /fault-directory-created/);
  await ensureDirectory(faulted);

  const bytes = Uint8Array.from([0, 1, 2, 255]);
  const binary = path.join(target, "snapshot.bin");
  await writeFileDurable(binary, bytes);
  assert.deepEqual(await readFile(binary), Buffer.from(bytes));
});
