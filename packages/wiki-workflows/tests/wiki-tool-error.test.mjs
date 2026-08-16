import assert from "node:assert/strict";
import test from "node:test";
import { wikiToolRejected } from "../dist/wiki-tool-error.js";

test("formats wiki_plan rejected: path 'core/models.md' is not a legal cluster page", () => {
  const error = wikiToolRejected("wiki_plan", "path 'core/models.md' is not a legal cluster page");
  assert.equal(error.message, "wiki_plan rejected: path 'core/models.md' is not a legal cluster page");
  assert.equal(error.message.includes("\n"), false);
});

test("strips newlines from reason", () => {
  const error = wikiToolRejected(
    "wiki_plan",
    "path 'core/models.md'\nis not a legal\r\ncluster page",
  );
  assert.equal(error.message, "wiki_plan rejected: path 'core/models.md' is not a legal cluster page");
  assert.equal(error.message.split("\n").length, 1);
});

test("name/message usable as thrown Error", () => {
  const error = wikiToolRejected("wiki_plan", "path 'core/models.md' is not a legal cluster page");
  assert.ok(error instanceof Error);
  assert.equal(typeof error.name, "string");
  assert.ok(error.name.length > 0);
  assert.equal(error.message, "wiki_plan rejected: path 'core/models.md' is not a legal cluster page");
  assert.throws(
    () => {
      throw wikiToolRejected("wiki_plan", "path 'core/models.md' is not a legal cluster page");
    },
    (thrown) => {
      assert.ok(thrown instanceof Error);
      assert.equal(thrown.name, error.name);
      assert.equal(thrown.message, error.message);
      return true;
    },
  );
});
