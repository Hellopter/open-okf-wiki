import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { writeMergedDefects } from "./defects.js";
import { defaultSpecStore } from "../ports/core-spec-store.js";
import { scorePublishable } from "./publishability.js";

test("scorePublishable: happy path with page + clean defects", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-pub-ok-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nHello ([Source](repo:README.md#L1-L1)).\n",
    "utf8",
  );
  const sourcePath = path.join(root, "src");
  await mkdir(sourcePath, { recursive: true });
  await writeFile(path.join(sourcePath, "README.md"), "# hi\n", "utf8");

  const spec = defaultWikiRunSpec("Publish Ok");
  await defaultSpecStore.commitSpec(root, "run-pub-ok", spec);
  await writeMergedDefects(root, "run-pub-ok", {
    version: 1,
    clean: true,
    defects: [],
    reviewerIds: ["r1"],
    summary: "NO_DEFECTS",
  });

  const scored = await scorePublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-pub-ok",
    sources: [{ id: "main", path: sourcePath }],
    spec,
    requireReviewReceipt: true,
  });
  assert.equal(scored.publishable, true, scored.reasons.join("; "));
  assert.ok(scored.pages.includes("overview.md"));
});

test("scorePublishable: fails when critical page missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-pub-fail-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(wikiRoot, { recursive: true });
  // Only index.md — missing critical overview.md from defaultWikiRunSpec.
  await writeFile(path.join(wikiRoot, "index.md"), "# Index\n", "utf8");

  const spec = defaultWikiRunSpec("Publish Fail");
  const scored = await scorePublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-pub-fail",
    sources: [],
    spec,
    requireReviewReceipt: false,
  });
  assert.equal(scored.publishable, false);
  assert.ok(scored.reasons.some((r) => /missing critical page/i.test(r)));
});
