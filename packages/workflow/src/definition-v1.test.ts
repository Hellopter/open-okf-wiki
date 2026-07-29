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

test("buildDefinitionV1Graph applies maxDomainFanOut and maxLeafFanOut", () => {
  const spec = defaultWikiRunSpec("Fanout");
  spec.domains = [
    {
      id: "a",
      title: "A",
      scope: "a",
      critical: true,
      questions: ["q1", "q2", "q3"],
    },
    {
      id: "b",
      title: "B",
      scope: "b",
      critical: false,
      questions: ["q1"],
    },
    {
      id: "c",
      title: "C",
      scope: "c",
      critical: false,
      questions: ["q1"],
    },
  ];
  const graph = buildDefinitionV1Graph(spec, { maxDomainFanOut: 2, maxLeafFanOut: 1 });
  const leaves = graph.nodes.filter((n) => n.kind === "research.leaf");
  const domains = graph.nodes.filter((n) => n.kind === "research.domain");
  assert.equal(domains.length, 2);
  assert.equal(leaves.length, 2);
  assert.ok(leaves.every((n) => n.key.endsWith(".1")));
  assert.equal(
    graph.nodes.some((n) => n.key === "research.domain.c"),
    false,
  );
});

test("buildDefinitionV1Graph omitted options use DEFAULT_ORCHESTRATION (4/6/3), not schema max", () => {
  const spec = defaultWikiRunSpec("Defaults");
  // 5 domains × 7 questions each — caps should bite at 4 domains and 6 leaves.
  spec.domains = Array.from({ length: 5 }, (_, i) => ({
    id: `d${i}`,
    title: `D${i}`,
    scope: `d${i}`,
    critical: i === 0,
    questions: Array.from({ length: 7 }, (_, q) => `q${q}`),
  }));
  const graph = buildDefinitionV1Graph(spec);
  const domains = graph.nodes.filter((n) => n.kind === "research.domain");
  const leaves = graph.nodes.filter((n) => n.kind === "research.leaf");
  const seats = graph.nodes.filter((n) => n.kind === "review.seat");
  assert.equal(domains.length, 4);
  assert.equal(leaves.length, 4 * 6);
  assert.equal(seats.length, 3);
  assert.ok(seats.some((n) => n.key === "review.seat.grounding"));
  assert.ok(seats.some((n) => n.key === "review.seat.coverage"));
  assert.ok(seats.some((n) => n.key === "review.seat.consistency"));
  assert.equal(
    seats.some((n) => n.key === "review.seat.general"),
    false,
  );
});
