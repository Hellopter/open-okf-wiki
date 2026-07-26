import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runWorkdirLayout } from "../runtime/workdir.js";
import { listWikiMarkdown, writeFixtureWiki } from "./wiki-pages.js";

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
});
