import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWikiRunEvent,
  parseWikiRunIndexEvent,
  parseWikiRunSnapshotEvent,
} from "./wiki-runs-events.ts";

test("Run SSE decoders reject malformed frames", () => {
  assert.throws(() => parseWikiRunIndexEvent('{"runs":{}}'));
  assert.throws(() => parseWikiRunSnapshotEvent('{"snapshot":{}}'));
  assert.throws(() => parseWikiRunEvent("{}"));
});
