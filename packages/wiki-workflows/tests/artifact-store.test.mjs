import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWikiArtifactStore,
  MAX_WIKI_JSON_ARTIFACT_BYTES,
  MAX_WIKI_RESEARCH_ARTIFACT_BYTES,
} from "../dist/artifact-store.js";

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-artifacts-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  return { workspace, store: createWikiArtifactStore({ workspace }) };
}

function digest(content) {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

test("writes content-addressed blobs and a per-run manifest", async (t) => {
  const { workspace, store } = await fixture(t);
  const location = { runId: "run-1", nodeId: "research-1", attempt: 1, kind: "research" };
  assert.equal(
    await store.prepare(location),
    ".okf-wiki/runs/run-1/staging/research-1/attempt-1/research.json",
  );

  const content = `${JSON.stringify({
    summary: "中文 and quoted evidence",
    findings: [{
      kind: "concept",
      title: "Core concept",
      readerQuestion: "What does the core concept mean?",
      priority: "critical",
      evidence: ["api/src/core.ts#L1-L8"],
    }],
    gaps: [],
  })}\n`;
  const ref = await store.write({ ...location, content });
  const sha = digest(content);
  assert.equal(ref.mediaType, "application/json");
  assert.equal(ref.sizeBytes, Buffer.byteLength(content, "utf8"));
  assert.equal(ref.sha256, sha);
  assert.equal(ref.relativePath, `.okf-wiki/blobs/${sha}.json`);
  assert.equal(store.resolve(ref), ref.relativePath);
  assert.equal(await store.read(ref), content);
  assert.deepEqual(await store.list("run-1", "research-1", 1), [ref]);
  assert.equal(await readFile(path.join(workspace, ".gitignore"), "utf8"), ".okf-wiki/\n");

  const blobOnDisk = await readFile(path.join(workspace, ".okf-wiki", "blobs", `${sha}.json`), "utf8");
  assert.equal(blobOnDisk, content);

  const manifest = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "runs", "run-1", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.artifacts, [ref]);
});

test("prepare stages for agents; finalize hashes staging into a blob", async (t) => {
  const { workspace, store } = await fixture(t);
  const location = { runId: "run-stage", nodeId: "synthesis-1", attempt: 2, kind: "synthesis" };
  const stagingRelative = await store.prepare(location);
  assert.equal(stagingRelative, ".okf-wiki/runs/run-stage/staging/synthesis-1/attempt-2/synthesis.json");

  const content = '{"decision":"continue","notes":"from staging"}\n';
  await writeFile(path.join(workspace, stagingRelative), content, "utf8");

  const ref = await store.finalize(location);
  assert.equal(ref.relativePath, `.okf-wiki/blobs/${digest(content)}.json`);
  assert.equal(await store.read(ref), content);
  assert.deepEqual(await store.list("run-stage", "synthesis-1", 2), [ref]);

  // Staging file may remain; durable pointer is the blob + run manifest.
  assert.equal(await readFile(path.join(workspace, stagingRelative), "utf8"), content);
});

test("rejects unsafe paths, symlinks, invalid UTF-8, and oversized artifacts", async (t) => {
  const { workspace, store } = await fixture(t);
  await assert.rejects(
    () => store.prepare({ runId: "../escape", nodeId: "node", attempt: 1, kind: "research" }),
    /Invalid Wiki handoff run ID/,
  );
  await assert.rejects(
    () => store.write({ runId: "run", nodeId: "node", attempt: 1, kind: "research", content: "x".repeat(MAX_WIKI_RESEARCH_ARTIFACT_BYTES + 1) }),
    /262144-byte limit/,
  );
  await assert.rejects(
    () => store.write({ runId: "run", nodeId: "review", attempt: 1, kind: "review", content: "x".repeat(MAX_WIKI_JSON_ARTIFACT_BYTES + 1) }),
    /262144-byte limit/,
  );

  const location = { runId: "run", nodeId: "node", attempt: 1, kind: "research" };
  const relative = await store.prepare(location);
  await writeFile(path.join(workspace, relative), Buffer.from([0xc3, 0x28]));
  await assert.rejects(() => store.finalize(location), /valid UTF-8/);

  const valid = await store.write({ ...location, content: "# valid\n" });
  const blobPath = path.join(workspace, valid.relativePath);
  const target = path.join(workspace, "outside.md");
  await writeFile(target, "outside\n", "utf8");
  await rm(blobPath);
  await symlink(target, blobPath);
  await assert.rejects(() => store.read(valid), /symbolic link/);

  // Staging path symlink is also rejected on finalize / rewrite.
  await rm(path.join(workspace, relative));
  await symlink(target, path.join(workspace, relative));
  await assert.rejects(() => store.finalize(location), /symbolic link/);

  const unsafeWorkspace = path.join(workspace, "unsafe-workspace");
  const externalRoot = path.join(workspace, "external-root");
  await mkdir(unsafeWorkspace);
  await mkdir(externalRoot);
  await symlink(externalRoot, path.join(unsafeWorkspace, ".okf-wiki"));
  const escaped = createWikiArtifactStore({ workspace: unsafeWorkspace });
  await assert.rejects(
    () => escaped.prepare({ runId: "run-2", nodeId: "node", attempt: 1, kind: "research" }),
    /symbolic link/,
  );
});

test("copyRun rewrites the manifest and shares content-addressed blobs", async (t) => {
  const { workspace, store } = await fixture(t);
  const content = '{"decision":"finalize"}\n';
  const source = await store.write({
    runId: "source-run",
    nodeId: "synthesis-1",
    attempt: 2,
    kind: "synthesis",
    content,
  });
  const sha = digest(content);
  assert.equal(source.relativePath, `.okf-wiki/blobs/${sha}.json`);

  const copied = await store.copyRun("source-run", "fork-run");
  assert.equal(copied.length, 1);
  assert.equal(copied[0].runId, "fork-run");
  assert.equal(copied[0].attempt, 2);
  assert.equal(copied[0].nodeId, "synthesis-1");
  assert.equal(copied[0].sha256, source.sha256);
  assert.equal(copied[0].relativePath, source.relativePath);
  assert.equal(await store.read(copied[0]), await store.read(source));

  const forkManifest = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "runs", "fork-run", "manifest.json"), "utf8"));
  assert.equal(forkManifest.artifacts[0].runId, "fork-run");

  const sourceRunRoot = path.join(workspace, ".okf-wiki", "runs", "source-run");
  await mkdir(path.join(sourceRunRoot, "publish-backup"), { recursive: true });
  await writeFile(path.join(sourceRunRoot, "publish.json"), '{"state":"backed_up"}\n', "utf8");
  await writeFile(path.join(sourceRunRoot, "publish-backup", "overview.md"), "recoverable\n", "utf8");
  assert.equal(await store.removeRun("source-run"), true);
  assert.equal(await store.removeRun("source-run"), false);
  assert.equal(await readFile(path.join(sourceRunRoot, "publish.json"), "utf8"), '{"state":"backed_up"}\n');
  assert.equal(await readFile(path.join(sourceRunRoot, "publish-backup", "overview.md"), "utf8"), "recoverable\n");
  // Blobs are retained after removeRun; fork can still read shared content.
  assert.equal(await store.read(copied[0]), content);
  assert.equal(await readFile(path.join(workspace, ".okf-wiki", "blobs", `${sha}.json`), "utf8"), content);
});

test("stores coordinator write reports as JSON blobs", async (t) => {
  const { store } = await fixture(t);
  const content = '{"pages":[{"path":"wiki/core/architecture.md","state":"missing"}]}\n';
  const ref = await store.write({
    runId: "run",
    nodeId: "writer-core",
    attempt: 1,
    kind: "write_report",
    content,
  });
  assert.equal(ref.relativePath, `.okf-wiki/blobs/${digest(content)}.json`);
  assert.equal(ref.mediaType, "application/json");
  assert.match(await store.read(ref), /wiki\/core\/architecture\.md/);
});

test("identical content reuses the same blob file", async (t) => {
  const { workspace, store } = await fixture(t);
  const content = '{"shared":true}\n';
  const a = await store.write({ runId: "run-a", nodeId: "n1", attempt: 1, kind: "inspection", content });
  const b = await store.write({ runId: "run-b", nodeId: "n2", attempt: 1, kind: "inspection", content });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.relativePath, b.relativePath);
  assert.equal(await readFile(path.join(workspace, a.relativePath), "utf8"), content);
});

test("blob GC skips active runs and removes only unreferenced blobs after they finish", async (t) => {
  const { workspace, store } = await fixture(t);
  const kept = await store.write({ runId: "kept", nodeId: "n", attempt: 1, kind: "inspection", content: '{"kept":true}\n' });
  const orphan = await store.write({ runId: "orphan", nodeId: "n", attempt: 1, kind: "inspection", content: '{"orphan":true}\n' });
  await writeFile(path.join(workspace, ".okf-wiki", "runs", "kept", "run.json"), '{"status":"running"}\n', "utf8");
  await store.removeRun("orphan");

  assert.deepEqual(await store.garbageCollect(), { skipped: true, scanned: 0, removed: 0 });
  assert.equal(await readFile(path.join(workspace, orphan.relativePath), "utf8"), '{"orphan":true}\n');

  await writeFile(path.join(workspace, ".okf-wiki", "runs", "kept", "run.json"), '{"status":"succeeded"}\n', "utf8");
  assert.deepEqual(await store.garbageCollect(), { skipped: false, scanned: 2, removed: 1 });
  assert.equal(await readFile(path.join(workspace, kept.relativePath), "utf8"), '{"kept":true}\n');
  await assert.rejects(readFile(path.join(workspace, orphan.relativePath), "utf8"), { code: "ENOENT" });
});
