import assert from "node:assert/strict";
import test from "node:test";
import { configureHref, operateHref, wikiHref } from "../workspace-path.ts";

test("operate href targets the unified Session and WikiRun workbench", () => {
  assert.equal(operateHref("team/wiki"), "/w/team%2Fwiki");
});

test("wiki and configure hrefs live under /w/:id", () => {
  assert.equal(wikiHref("ws1"), "/w/ws1/wiki");
  assert.equal(wikiHref("ws1", "overview.md"), "/w/ws1/wiki/overview.md");
  assert.equal(wikiHref("ws1", "a/b.md"), "/w/ws1/wiki/a/b.md");
  assert.equal(configureHref("ws1"), "/w/ws1/configure");
  assert.equal(configureHref("ws1", "sources"), "/w/ws1/configure#sources");
});
