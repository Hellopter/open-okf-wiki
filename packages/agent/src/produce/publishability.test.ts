import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { regenerateWikiIndexes } from "@okf-wiki/core";
import { defaultSpecStore } from "../ports/core-spec-store.js";
import { writeMergedDefects } from "./defects-io.js";
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
  await regenerateWikiIndexes(wikiRoot);
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
  assert.ok(scored.pages.includes("index.md"));
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

test("scorePublishable: fails on flat deep index links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-pub-flat-idx-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(path.join(wikiRoot, "modules"), { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nHello.\n",
    "utf8",
  );
  await writeFile(
    path.join(wikiRoot, "modules", "core.md"),
    "---\ntype: Module\ntitle: Core\n---\n\n# Core\n\nBody.\n",
    "utf8",
  );
  // Bad flat index: deep-links past progressive disclosure.
  await writeFile(
    path.join(wikiRoot, "index.md"),
    "# Bad\n\n* [Overview](overview.md)\n* [Core](modules/core.md)\n",
    "utf8",
  );

  const scored = await scorePublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-flat-idx",
    sources: [],
    requireReviewReceipt: false,
  });
  assert.equal(scored.publishable, false);
  assert.ok(
    scored.reasons.some((r) => /indexes:/i.test(r) && /modules\/core\.md/i.test(r)),
    scored.reasons.join("; "),
  );
});

test("scorePublishable: nested concepts pass after regenerateWikiIndexes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-pub-nested-idx-"));
  const wikiRoot = path.join(root, "wiki");
  await mkdir(path.join(wikiRoot, "modules"), { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\n---\n\n# Overview\n\nHello.\n",
    "utf8",
  );
  await writeFile(
    path.join(wikiRoot, "modules", "core.md"),
    "---\ntype: Module\ntitle: Core\n---\n\n# Core\n\nBody.\n",
    "utf8",
  );
  await regenerateWikiIndexes(wikiRoot);

  const scored = await scorePublishable({
    wikiRoot,
    workspaceRoot: root,
    runId: "run-nested-idx",
    sources: [],
    requireReviewReceipt: false,
  });
  assert.equal(scored.publishable, true, scored.reasons.join("; "));
  assert.ok(scored.pages.includes("modules/index.md"));
});
