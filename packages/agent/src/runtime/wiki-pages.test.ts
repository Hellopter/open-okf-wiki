import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runWorkdirLayout } from "./workdir.js";
import { listWikiMarkdown, materializeWikiIndexes, writeFixtureWiki } from "./wiki-pages.js";

test("listWikiMarkdown: empty when wiki dir missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-pages-miss-"));
  const pages = await listWikiMarkdown(path.join(root, "no-such-wiki"));
  assert.deepEqual(pages, []);
});

test("writeFixtureWiki + listWikiMarkdown: happy fixture pages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-pages-ok-"));
  const runWorkDir = path.join(root, "run");
  await mkdir(path.join(runWorkDir, "sources", "main"), { recursive: true });
  const layout = runWorkdirLayout(
    runWorkDir,
    new Map([["main", path.join(runWorkDir, "sources", "main")]]),
  );

  const written = await writeFixtureWiki(layout, "Fixture Title");
  assert.deepEqual(written.sort(), ["index.md", "overview.md"]);

  const listed = await listWikiMarkdown(layout.wikiDir);
  assert.deepEqual(listed.sort(), ["index.md", "overview.md"]);

  const overview = await readFile(path.join(layout.wikiDir, "overview.md"), "utf8");
  assert.match(overview, /type: Overview/);
  assert.match(overview, /Fixture Title/);
  assert.match(overview, /repo:README\.md/);

  // Mechanical materialize: root index lists overview as progressive disclosure.
  const index = await readFile(path.join(layout.wikiDir, "index.md"), "utf8");
  assert.match(index, /overview\.md/);
});

test("materializeWikiIndexes: pages list includes nested index after materialize", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-pages-nested-"));
  const wikiDir = path.join(root, "wiki");
  await mkdir(path.join(wikiDir, "modules"), { recursive: true });
  await writeFile(
    path.join(wikiDir, "overview.md"),
    "---\ntype: Overview\ntitle: Overview\ndescription: Intro.\n---\n\n# Overview\n",
    "utf8",
  );
  await writeFile(
    path.join(wikiDir, "modules/core.md"),
    "---\ntype: Module\ntitle: Core\ndescription: Core module.\n---\n\n# Core\n",
    "utf8",
  );

  // Before materialize: only concept pages.
  assert.deepEqual((await listWikiMarkdown(wikiDir)).sort(), ["modules/core.md", "overview.md"]);

  const indexes = await materializeWikiIndexes(wikiDir);
  assert.ok(indexes.written.includes("index.md"));
  assert.ok(indexes.written.includes("modules/index.md"));

  // After materialize: nested index appears in the page list (write-phase refresh contract).
  const pages = await listWikiMarkdown(wikiDir);
  assert.ok(pages.includes("index.md"));
  assert.ok(pages.includes("modules/index.md"));
  assert.ok(pages.includes("modules/core.md"));
  assert.ok(pages.includes("overview.md"));
});
