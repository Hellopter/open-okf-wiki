import assert from "node:assert/strict";
import test from "node:test";
import { sameStringSet, stableStringify } from "../dist/util.js";

test("stableStringify sorts keys while preserving JSON omission and array null semantics", () => {
  const value = {
    z: undefined,
    b: { skipped: undefined, kept: true },
    a: [undefined, () => {}, Symbol("ignored"), 1],
  };
  assert.equal(stableStringify(value), '{"a":[null,null,null,1],"b":{"kept":true}}');
  assert.deepEqual(JSON.parse(stableStringify(value)), JSON.parse(JSON.stringify(value)));
  assert.throws(() => stableStringify(undefined), /non-JSON top-level value/);
});

test("sameStringSet compares unique membership independently of order", () => {
  assert.equal(sameStringSet(["b", "a", "a"], ["a", "b"]), true);
  assert.equal(sameStringSet(["a"], ["a", "b"]), false);
});
