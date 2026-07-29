import assert from "node:assert/strict";
import { test } from "node:test";
import { WIKI_PRODUCE_RECEIPT_STATUSES, WikiProduceToolStatusSchema } from "./run-phase.js";

test("WikiProduceToolStatusSchema accepts receipt writes and historical read values", () => {
  for (const status of WIKI_PRODUCE_RECEIPT_STATUSES) {
    assert.equal(WikiProduceToolStatusSchema.parse(status), status);
  }
  // Historical JSONL rows still parse for history projection.
  assert.equal(WikiProduceToolStatusSchema.parse("awaiting_plan"), "awaiting_plan");
  assert.equal(WikiProduceToolStatusSchema.parse("published"), "published");
  assert.equal(WikiProduceToolStatusSchema.safeParse("queued").success, false);
});
