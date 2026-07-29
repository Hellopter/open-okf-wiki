import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import {
  buildDefinitionV1Graph,
  isMechanicalAttemptKind,
  isPiAttemptKind,
} from "./definition-v1.js";

test("buildDefinitionV1Graph orders leaves before domains and ends at publish", () => {
  const graph = buildDefinitionV1Graph(defaultWikiRunSpec("Demo"));
  const keys = graph.nodes.map((n) => n.key);
  assert.ok(keys.includes("research.leaf.core.1"));
  assert.ok(keys.includes("research.leaf.core.2"));
  assert.ok(keys.includes("research.domain.core"));
  assert.ok(keys.includes("write.root"));
  assert.ok(keys.includes("validate.pre"));
  assert.ok(keys.includes("review.seat.grounding"));
  assert.ok(keys.includes("review.reduce"));
  assert.ok(keys.includes("validate.final"));
  assert.ok(keys.includes("prepare.publication"));
  assert.ok(keys.includes("gate.publication"));
  assert.ok(keys.includes("publish"));

  assert.ok(
    graph.edges.some((e) => e.from === "research.leaf.core.1" && e.to === "research.domain.core"),
  );
  assert.ok(graph.edges.some((e) => e.from === "research.domain.core" && e.to === "write.root"));
  assert.ok(graph.edges.some((e) => e.from === "gate.publication" && e.to === "publish"));
  assert.equal(isPiAttemptKind("research.leaf"), true);
  assert.equal(isMechanicalAttemptKind("validate.pre"), true);
  assert.equal(isPiAttemptKind("publish"), false);
});

test("buildDefinitionV1Graph without domains wires plan → write.root", () => {
  const spec = defaultWikiRunSpec("Empty");
  spec.domains = [];
  const graph = buildDefinitionV1Graph(spec);
  assert.ok(graph.edges.some((e) => e.from === "plan" && e.to === "write.root"));
  assert.equal(
    graph.nodes.some((n) => n.kind === "research.domain"),
    false,
  );
});
