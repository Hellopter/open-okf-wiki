import assert from "node:assert/strict";
import { test } from "node:test";
import { WIKI_PRODUCE_RECEIPT_STATUSES, WikiProduceToolStatusSchema } from "./run-phase.js";

test("WikiProduceToolStatusSchema accepts only v2 receipt states", () => {
  for (const status of WIKI_PRODUCE_RECEIPT_STATUSES) {
    assert.equal(WikiProduceToolStatusSchema.parse(status), status);
  }
  assert.equal(WikiProduceToolStatusSchema.safeParse("awaiting_plan").success, false);
  assert.equal(WikiProduceToolStatusSchema.safeParse("published").success, false);
  assert.equal(WikiProduceToolStatusSchema.safeParse("queued").success, false);
});
