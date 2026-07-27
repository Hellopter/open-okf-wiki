import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { topologyFromSpec } from "./topology.js";

test("topologyFromSpec builds plan/domain/leaf/write/review chain", () => {
  const spec = defaultWikiRunSpec("demo");
  const topo = topologyFromSpec(spec);
  const keys = topo.map((n) => n.nodeKey);
  assert.ok(keys.includes("plan"));
  assert.ok(keys.includes("domain-core"));
  assert.ok(keys.includes("leaf-core-1"));
  assert.ok(keys.includes("leaf-core-2"));
  assert.ok(keys.includes("root_write"));
  assert.ok(keys.includes("review"));
  assert.ok(keys.includes("publish"));

  const domain = topo.find((n) => n.nodeKey === "domain-core");
  assert.equal(domain?.kind, "domain");
  assert.equal(domain?.parentKey, "plan");

  const leaf = topo.find((n) => n.nodeKey === "leaf-core-1");
  assert.equal(leaf?.parentKey, "domain-core");
});
