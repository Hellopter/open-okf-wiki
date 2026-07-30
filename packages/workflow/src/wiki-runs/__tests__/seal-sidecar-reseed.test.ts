/**
 * Regression: repair/refresh re-seed from a sealed wiki_tree that already
 * contains `.okf-artifact-manifest.json`. Prepare+seal must use content-only
 * digests or final verify throws "sealed artifact verification failed".
 */

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runWorkDir } from "@okf-wiki/core";
import { sealPreparation, verifyArtifact } from "../artifacts.js";
import { digest } from "../crypto-util.js";
import { manifestFor } from "../fs-util.js";
import type { ArtifactPreparation } from "../types.js";

async function writeWikiPage(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "overview.md"),
    ["---", "type: Overview", 'title: "Seal reseed"', "---", "", body, ""].join("\n"),
    "utf8",
  );
}

test("sealPreparation re-seals a tree that still carries a prior seal sidecar", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-seal-reseed-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const runId = "run-reseed";
  // sealPreparation only reads workspace.rootPath.
  const host = { workspace: { rootPath: root } } as Parameters<typeof sealPreparation>[0];

  // First seal: clean wiki (no sidecar).
  const wiki1 = path.join(root, "wiki1");
  await writeWikiPage(wiki1, "# first");
  const stage1 = path.join(root, "stage1");
  await cp(wiki1, stage1, { recursive: true });
  const manifest1 = await manifestFor(stage1, true);
  const digest1 = digest(manifest1);
  const prep1: ArtifactPreparation = {
    artifactId: `${runId}:wiki_tree:${digest1}`,
    digest: digest1,
    kind: "wiki_tree",
    preparationId: "prep-1",
    relativePath: `artifacts/wiki_tree-${digest1}`,
    role: "wiki_tree",
    sourceDirectory: stage1,
  };
  await sealPreparation(host, runId, prep1);
  const sealed1 = path.join(runWorkDir(root, runId), prep1.relativePath);
  assert.equal(await verifyArtifact(sealed1, digest1), true);
  // Sidecar is present on the sealed tree.
  assert.match(
    await readFile(path.join(sealed1, ".okf-artifact-manifest.json"), "utf8"),
    /"schema"\s*:\s*1/,
  );

  // Repair-style reseed: copy sealed tree (sidecar included) into working wiki,
  // edit content, stage, prepare with content-only digest, seal again.
  const wiki2 = path.join(root, "wiki2");
  await cp(sealed1, wiki2, { recursive: true, dereference: false });
  await writeWikiPage(wiki2, "# repaired");
  // Sidecar from the prior seal is still present (materialize/readSealedWikiTree).
  await readFile(path.join(wiki2, ".okf-artifact-manifest.json"), "utf8");

  const stage2 = path.join(root, "stage2");
  await cp(wiki2, stage2, { recursive: true, dereference: false });

  // Content-only digest ignores the stale sidecar; full-tree digest would differ.
  const contentManifest = await manifestFor(stage2, true);
  const fullManifest = await manifestFor(stage2, false);
  const contentDigest = digest(contentManifest);
  const fullDigest = digest(fullManifest);
  assert.notEqual(
    contentDigest,
    fullDigest,
    "stale seal sidecar must change full-tree digest (bug trigger)",
  );

  const prep2: ArtifactPreparation = {
    artifactId: `${runId}:wiki_tree:${contentDigest}`,
    digest: contentDigest,
    kind: "wiki_tree",
    preparationId: "prep-2",
    relativePath: `artifacts/wiki_tree-${contentDigest}`,
    role: "wiki_tree",
    sourceDirectory: stage2,
  };
  // Must not throw "sealed artifact verification failed".
  await sealPreparation(host, runId, prep2);
  const sealed2 = path.join(runWorkDir(root, runId), prep2.relativePath);
  assert.equal(await verifyArtifact(sealed2, contentDigest), true);
});
