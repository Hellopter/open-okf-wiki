import assert from "node:assert/strict";
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

test("writes UTF-8 artifacts atomically with a hashed attempt manifest", async (t) => {
  const { workspace, store } = await fixture(t);
  const location = { runId: "run-1", nodeId: "research-1", attempt: 1, kind: "research" };
  assert.equal(await store.prepare(location), ".okf-wiki/runs/run-1/research-1/attempt-1/research.md");

  const content = [
    "# Evidence",
    "中文 and \"quotes\" with `backticks`",
    "```mermaid",
    "flowchart LR",
    "  A[\"quoted\"] --> B[path\\name]",
    "```",
    "",
  ].join("\r\n");
  const ref = await store.write({ ...location, content });
  assert.equal(ref.mediaType, "text/markdown");
  assert.equal(ref.sizeBytes, Buffer.byteLength(content, "utf8"));
  assert.match(ref.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await store.read(ref), content);
  assert.deepEqual(await store.list("run-1", "research-1", 1), [ref]);
  assert.equal(await readFile(path.join(workspace, ".gitignore"), "utf8"), ".okf-wiki/\n");

  const manifest = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "runs", "run-1", "research-1", "attempt-1", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.artifacts, [ref]);
});

test("rejects unsafe paths, symlinks, invalid UTF-8, and oversized artifacts", async (t) => {
  const { workspace, store } = await fixture(t);
  await assert.rejects(
    () => store.prepare({ runId: "../escape", nodeId: "node", attempt: 1, kind: "research" }),
    /Invalid Wiki handoff run ID/,
  );
  await assert.rejects(
    () => store.write({ runId: "run", nodeId: "node", attempt: 1, kind: "research", content: "x".repeat(MAX_WIKI_RESEARCH_ARTIFACT_BYTES + 1) }),
    /65536-byte limit/,
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
  const artifact = path.join(workspace, relative);
  const target = path.join(workspace, "outside.md");
  await writeFile(target, "outside\n", "utf8");
  await rm(artifact);
  await symlink(target, artifact);
  await assert.rejects(() => store.read(valid), /symbolic link/);
  await assert.rejects(() => store.finalize(location), /symbolic link/);
  await assert.rejects(() => store.write({ ...location, content: "replacement\n" }), /symbolic link/);

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

test("copies attempt artifacts into a fork and removes a single run safely", async (t) => {
  const { store } = await fixture(t);
  const source = await store.write({
    runId: "source-run",
    nodeId: "synthesis-1",
    attempt: 2,
    kind: "synthesis",
    content: '{"decision":"finalize"}\n',
  });
  const copied = await store.copyRun("source-run", "fork-run");
  assert.equal(copied.length, 1);
  assert.equal(copied[0].runId, "fork-run");
  assert.equal(copied[0].attempt, 2);
  assert.equal(copied[0].relativePath, ".okf-wiki/runs/fork-run/synthesis-1/attempt-2/synthesis.json");
  assert.equal(await store.read(copied[0]), await store.read(source));
  assert.equal(await store.removeRun("source-run"), true);
  assert.equal(await store.removeRun("source-run"), false);
  assert.equal(await store.read(copied[0]), '{"decision":"finalize"}\n');
});

test("stores coordinator write reports as JSON artifacts", async (t) => {
  const { store } = await fixture(t);
  const ref = await store.write({
    runId: "run",
    nodeId: "writer-core",
    attempt: 1,
    kind: "write_report",
    content: '{"pages":[{"path":"wiki/core/architecture.md","state":"missing"}]}\n',
  });
  assert.equal(ref.relativePath, ".okf-wiki/runs/run/writer-core/attempt-1/write_report.json");
  assert.equal(ref.mediaType, "application/json");
  assert.match(await store.read(ref), /wiki\/core\/architecture\.md/);
});
