import assert from "node:assert/strict";
import test from "node:test";
import { newCommandId } from "../command-id.ts";

test("newCommandId uses the platform UUID when available", () => {
  assert.equal(newCommandId({ randomUuid: () => "platform-id" }), "platform-id");
});

test("newCommandId has a non-empty fallback without Web Crypto", () => {
  const commandId = newCommandId({ now: () => 1234, random: () => 0.5 });
  assert.match(commandId, /^cmd-[a-z0-9]+-[a-z0-9]+$/);
});

test("newCommandId uses random values before the weak fallback", () => {
  const commandId = newCommandId({
    getRandomValues: (values) => {
      values.set([1, 2, 3, 4]);
      return values;
    },
  });
  assert.equal(commandId, "cmd-0000001000000200000030000004");
});
