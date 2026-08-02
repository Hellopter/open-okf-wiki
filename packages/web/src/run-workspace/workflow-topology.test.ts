import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunNode, WikiRunSnapshot } from "@okf-wiki/contract";
import {
  buildFocusTopology,
  buildWorkflowStages,
  projectCollapsedResearchLeaves,
  relationForEdge,
  researchDomainLeafGroups,
  shouldCollapseResearchLeaves,
} from "./workflow-topology.ts";

function node(key: string, kind: string, state = "succeeded"): WikiRunNode {
  return {
    key,
    kind: kind as WikiRunNode["kind"],
    label: key,
    state: state as WikiRunNode["state"],
    generation: 0,
  };
}

function snapshot(
  nodes: WikiRunNode[],
  edges: Array<{ from: string; to: string }>,
): WikiRunSnapshot {
  return { nodes, edges } as unknown as WikiRunSnapshot;
}

test("overview keeps a large research fan-out in one semantic stage", () => {
  const nodes = [
    node("plan", "plan"),
    ...Array.from({ length: 12 }, (_, index) =>
      node(`research.leaf.core.${index}`, "research.leaf"),
    ),
    node("write.root", "write.root"),
  ];
  const stages = buildWorkflowStages(snapshot(nodes, []), {
    plan: "Plan",
    research: "Research",
    synthesis: "Synthesis",
    quality: "Quality",
    publication: "Publish",
  });

  assert.equal(stages.find((stage) => stage.id === "research")?.total, 12);
  assert.equal(stages.find((stage) => stage.id === "plan")?.total, 1);
});

test("quality focus retains the repair feedback loop through its validation boundary", () => {
  const pre = node("validate.pre", "validate.pre");
  const seat = node("review.seat.quality", "review.seat");
  const reduce = node("review.reduce", "review.reduce");
  const repair = node("repair.1", "repair");
  const view = buildFocusTopology(
    snapshot(
      [pre, seat, reduce, repair],
      [
        { from: pre.key, to: seat.key },
        { from: seat.key, to: reduce.key },
        { from: reduce.key, to: repair.key },
        { from: repair.key, to: pre.key },
      ],
    ),
    "quality",
  );

  assert.equal(relationForEdge(repair, pre), "feedback");
  assert.deepEqual(
    view.nodes.map((item) => item.key),
    [pre.key, seat.key, reduce.key, repair.key],
  );
  assert.deepEqual([...view.contextNodeKeys], [pre.key]);
  assert.deepEqual(
    view.edges.map((edge) => [edge.source, edge.target, edge.relation]),
    [
      [pre.key, seat.key, "fanout"],
      [seat.key, reduce.key, "join"],
      [reduce.key, repair.key, "forward"],
      [repair.key, pre.key, "feedback"],
    ],
  );
});

test("research focus preserves real plan fan-out and writing fan-in boundary edges", () => {
  const plan = node("plan", "plan");
  const core = node("research.domain.core", "research.domain");
  const first = node("research.leaf.core.1", "research.leaf");
  const second = node("research.leaf.core.2", "research.leaf");
  const adaptation = node("plan.adapt.1", "plan.adapt");
  const write = node("write.root", "write.root");
  const view = buildFocusTopology(
    snapshot(
      [plan, first, second, core, adaptation, write],
      [
        { from: plan.key, to: first.key },
        { from: plan.key, to: second.key },
        { from: first.key, to: core.key },
        { from: second.key, to: core.key },
        { from: core.key, to: adaptation.key },
        { from: adaptation.key, to: write.key },
      ],
    ),
    "research",
  );

  assert.deepEqual([...view.contextNodeKeys], [plan.key, write.key]);
  assert.deepEqual(
    view.edges.map((edge) => [edge.source, edge.target, edge.relation]),
    [
      [plan.key, first.key, "fanout"],
      [plan.key, second.key, "fanout"],
      [first.key, core.key, "join"],
      [second.key, core.key, "join"],
      [core.key, adaptation.key, "join"],
      [adaptation.key, write.key, "forward"],
    ],
  );
});

function denseResearchTopology() {
  const plan = node("plan", "plan");
  const adapt = node("plan.adapt.1", "plan.adapt");
  const write = node("write.root", "write.root");
  const domains = ["a", "b"].map((id) => node(`research.domain.${id}`, "research.domain"));
  const leaves = domains.flatMap((domain) =>
    [1, 2, 3].map((n) =>
      node(`research.leaf.${domain.key.split(".").at(-1)}.${n}`, "research.leaf"),
    ),
  );
  const edges: Array<{ from: string; to: string }> = [];
  for (const leaf of leaves) {
    edges.push({ from: plan.key, to: leaf.key });
    const domainId = leaf.key.split(".")[2];
    edges.push({ from: leaf.key, to: `research.domain.${domainId}` });
  }
  for (const domain of domains) {
    edges.push({ from: domain.key, to: adapt.key });
  }
  edges.push({ from: adapt.key, to: write.key });
  return buildFocusTopology(snapshot([plan, ...leaves, ...domains, adapt, write], edges), "research");
}

test("research domain leaf groups map leaves under each domain", () => {
  const topology = denseResearchTopology();
  const groups = researchDomainLeafGroups(topology);
  assert.equal(groups.size, 2);
  assert.equal(groups.get("research.domain.a")?.length, 3);
  assert.equal(groups.get("research.domain.b")?.length, 3);
  assert.equal(shouldCollapseResearchLeaves(topology), true);
});

test("collapsed research projects plan onto domains and hides leaves", () => {
  const topology = denseResearchTopology();
  const collapsed = projectCollapsedResearchLeaves(topology, new Set());
  assert.equal(
    collapsed.nodes.some((item) => item.kind === "research.leaf"),
    false,
  );
  assert.deepEqual(
    collapsed.edges
      .filter((edge) => edge.source === "plan")
      .map((edge) => edge.target)
      .sort(),
    ["research.domain.a", "research.domain.b"],
  );
  assert.ok(collapsed.edges.some((edge) => edge.source === "research.domain.a" && edge.target === "plan.adapt.1"));
});

test("expanding one domain restores only its leaves", () => {
  const topology = denseResearchTopology();
  const partial = projectCollapsedResearchLeaves(topology, new Set(["research.domain.a"]));
  const leafKeys = partial.nodes.filter((item) => item.kind === "research.leaf").map((item) => item.key);
  assert.deepEqual(
    leafKeys.sort(),
    [
      "research.leaf.a.1",
      "research.leaf.a.2",
      "research.leaf.a.3",
    ].sort(),
  );
  assert.ok(partial.edges.some((edge) => edge.source === "plan" && edge.target === "research.leaf.a.1"));
  assert.ok(partial.edges.some((edge) => edge.source === "plan" && edge.target === "research.domain.b"));
});

test("small research graphs stay fully expanded", () => {
  const plan = node("plan", "plan");
  const domain = node("research.domain.core", "research.domain");
  const leaf = node("research.leaf.core.1", "research.leaf");
  const topology = buildFocusTopology(
    snapshot(
      [plan, leaf, domain],
      [
        { from: plan.key, to: leaf.key },
        { from: leaf.key, to: domain.key },
      ],
    ),
    "research",
  );
  assert.equal(shouldCollapseResearchLeaves(topology), false);
  const projected = projectCollapsedResearchLeaves(topology, new Set());
  assert.equal(projected.nodes.length, topology.nodes.length);
});
