import assert from "node:assert/strict";
import test from "node:test";
import {
  WIKI_DEFECT_LIST_LIMIT,
  WikiRejectedError,
  allowedList,
  listed,
} from "../dist/wiki-reject.js";

test("WikiRejectedError joins unique one-line defects", () => {
  const error = new WikiRejectedError([
    "missing headings: Scope",
    "missing headings: Scope",
    "invalid citations:\nsource/a.ts#L1",
    "  ",
  ]);
  assert.equal(error.name, "WikiRejectedError");
  assert.deepEqual([...error.defects], ["missing headings: Scope", "invalid citations: source/a.ts#L1"]);
  assert.equal(error.message, "missing headings: Scope; invalid citations: source/a.ts#L1");
  assert.equal(error.message.includes("\n"), false);
});

test("listed unique-caps a defect class and allowedList uses (none)", () => {
  assert.equal(listed(["a", "a", "b"]), "a, b");
  assert.equal(listed(Array.from({ length: WIKI_DEFECT_LIST_LIMIT + 3 }, (_, index) => `id-${index}`)), [
    ...Array.from({ length: WIKI_DEFECT_LIST_LIMIT }, (_, index) => `id-${index}`),
  ].join(", ") + " +3 more");
  assert.equal(allowedList([]), "(none)");
  assert.equal(allowedList(["source-a", "source-b"]), "source-a, source-b");
});
