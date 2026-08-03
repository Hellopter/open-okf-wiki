import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunNode, WikiRunSnapshot } from "@okf-wiki/contract";
import {
  buildFocusTopology,
  buildWorkflowStages,
  injectPlanScoutDisplayNodes,
  mergePlanScoutDisplays,
  orderedNodesForLayout,
  planScoutNodeKey,
  projectCollapsedResearchLeaves,
  relationForEdge,
  researchDomainLeafGroups,
  scoutKindsFromSnapshot,
  shouldCollapseResearchLeaves,
  stageForNode,
} from "./workflow-topology.ts";

function node(key: string, kind: string, state = "succeeded"): WikiRunNode {
  return {
    key,
    kind: kind as WikiRunNode["kind"],
    label: key,
    state: state as WikiRunNode["state"],
    generation: 0,
    currentAttemptId: null,
    lastAttemptId: null,
    outputs: [],
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
  return buildFocusTopology(
    snapshot([plan, ...leaves, ...domains, adapt, write], edges),
    "research",
  );
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
  assert.ok(
    collapsed.edges.some(
      (edge) => edge.source === "research.domain.a" && edge.target === "plan.adapt.1",
    ),
  );
});

test("expanding one domain restores only its leaves", () => {
  const topology = denseResearchTopology();
  const partial = projectCollapsedResearchLeaves(topology, new Set(["research.domain.a"]));
  const leafKeys = partial.nodes
    .filter((item) => item.kind === "research.leaf")
    .map((item) => item.key);
  assert.deepEqual(
    leafKeys.sort(),
    ["research.leaf.a.1", "research.leaf.a.2", "research.leaf.a.3"].sort(),
  );
  assert.ok(
    partial.edges.some((edge) => edge.source === "plan" && edge.target === "research.leaf.a.1"),
  );
  assert.ok(
    partial.edges.some((edge) => edge.source === "plan" && edge.target === "research.domain.b"),
  );
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

test("layout order clusters collapsed domains without leaf fan-out", () => {
  const topology = denseResearchTopology();
  const collapsed = projectCollapsedResearchLeaves(topology, new Set());
  const keys = orderedNodesForLayout(collapsed, {
    expandedDomainKeys: new Set(),
  }).map((item) => item.key);
  assert.deepEqual(keys, [
    "plan",
    "research.domain.a",
    "research.domain.b",
    "plan.adapt.1",
    "write.root",
  ]);
});

test("layout order clusters leaves under a partially expanded domain", () => {
  const topology = denseResearchTopology();
  const expanded = new Set(["research.domain.a"]);
  const partial = projectCollapsedResearchLeaves(topology, expanded);
  const keys = orderedNodesForLayout(partial, {
    expandedDomainKeys: expanded,
  }).map((item) => item.key);
  assert.deepEqual(keys, [
    "plan",
    "research.leaf.a.1",
    "research.leaf.a.2",
    "research.leaf.a.3",
    "research.domain.a",
    "research.domain.b",
    "plan.adapt.1",
    "write.root",
  ]);
});

test("layout order clusters leaves under each domain when fully expanded", () => {
  const topology = denseResearchTopology();
  const expanded = new Set(["research.domain.a", "research.domain.b"]);
  const full = projectCollapsedResearchLeaves(topology, expanded);
  const keys = orderedNodesForLayout(full, {
    expandedDomainKeys: expanded,
  }).map((item) => item.key);
  assert.deepEqual(keys, [
    "plan",
    "research.leaf.a.1",
    "research.leaf.a.2",
    "research.leaf.a.3",
    "research.domain.a",
    "research.leaf.b.1",
    "research.leaf.b.2",
    "research.leaf.b.3",
    "research.domain.b",
    "plan.adapt.1",
    "write.root",
  ]);
});

test("layout order places orphan research leaves after domain clusters", () => {
  const plan = node("plan", "plan");
  const domain = node("research.domain.a", "research.domain");
  const leaf = node("research.leaf.a.1", "research.leaf");
  const orphan = node("research.leaf.orphan.1", "research.leaf");
  const adapt = node("plan.adapt.1", "plan.adapt");
  const topology = buildFocusTopology(
    snapshot(
      [plan, leaf, domain, orphan, adapt],
      [
        { from: plan.key, to: leaf.key },
        { from: plan.key, to: orphan.key },
        { from: leaf.key, to: domain.key },
        { from: domain.key, to: adapt.key },
      ],
    ),
    "research",
  );
  const keys = orderedNodesForLayout(topology).map((item) => item.key);
  assert.deepEqual(keys, [
    "plan",
    "research.leaf.a.1",
    "research.domain.a",
    "research.leaf.orphan.1",
    "plan.adapt.1",
  ]);
});

test("plan.scout maps to plan stage and fanout/join relations", () => {
  const plan = node("plan", "plan");
  const scout = node("plan.scout.entry", "plan.scout");
  const gate = node("gate.plan", "gate.plan");
  assert.equal(stageForNode(scout), "plan");
  assert.equal(relationForEdge(plan, scout), "fanout");
  assert.equal(relationForEdge(scout, gate), "join");
});

test("injectPlanScoutDisplayNodes places scouts after plan before gate.plan", () => {
  const freeze = node("freeze", "freeze");
  const plan = node("plan", "plan", "succeeded");
  const gate = node("gate.plan", "gate.plan", "waiting");
  const baseNodes = [freeze, plan, gate];
  const baseEdges = [
    {
      id: "freeze->plan",
      source: "freeze",
      target: "plan",
      relation: "forward" as const,
    },
    {
      id: "plan->gate.plan",
      source: "plan",
      target: "gate.plan",
      relation: "control" as const,
    },
  ];
  const { nodes, edges } = injectPlanScoutDisplayNodes(
    baseNodes,
    baseEdges,
    [
      { kind: "entry", ok: true },
      { kind: "layout", ok: false },
    ],
    plan,
  );

  const topology = {
    nodes,
    edges,
    contextNodeKeys: new Set<string>(),
    topologyKey: "test",
  };
  const keys = orderedNodesForLayout(topology).map((item) => item.key);
  assert.deepEqual(keys, [
    "freeze",
    "plan",
    planScoutNodeKey("entry"),
    planScoutNodeKey("layout"),
    "gate.plan",
  ]);

  const layoutScout = nodes.find((item) => item.key === planScoutNodeKey("layout"));
  assert.equal(layoutScout?.state, "failed");
  const entryScout = nodes.find((item) => item.key === planScoutNodeKey("entry"));
  assert.equal(entryScout?.state, "succeeded");
  assert.equal(entryScout?.parentKey, "plan");

  assert.ok(edges.some((e) => e.source === "plan" && e.target === planScoutNodeKey("entry")));
  assert.ok(
    edges.some((e) => e.source === planScoutNodeKey("entry") && e.target === "gate.plan"),
  );
  assert.equal(
    edges.some((e) => e.source === "plan" && e.target === "gate.plan"),
    false,
    "direct plan→gate rewired through scouts",
  );
});

test("injectPlanScoutDisplayNodes is a no-op without scouts", () => {
  const plan = node("plan", "plan");
  const gate = node("gate.plan", "gate.plan");
  const edges = [
    { id: "plan->gate.plan", source: "plan", target: "gate.plan", relation: "control" as const },
  ];
  const result = injectPlanScoutDisplayNodes([plan, gate], edges, [], plan);
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 1);
});

test("scoutKindsFromSnapshot reads metrics.extra.scoutKinds from latest plan attempt", () => {
  const snap = {
    attempts: [
      {
        attemptId: "a1",
        nodeKey: "plan",
        nodeGeneration: 0,
        runIndex: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        metrics: { extra: { scoutKinds: ["entry", "layout"] } },
      },
    ],
  } as unknown as WikiRunSnapshot;
  assert.deepEqual(scoutKindsFromSnapshot(snap), ["entry", "layout"]);
  assert.deepEqual(scoutKindsFromSnapshot({ attempts: [] } as unknown as WikiRunSnapshot), []);
});

test("mergePlanScoutDisplays prefers review rows over metrics kinds", () => {
  const merged = mergePlanScoutDisplays(
    [{ kind: "entry", ok: true, preview: "# hi" }],
    ["entry", "layout"],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((s) => s.kind === "entry")?.preview, "# hi");
  assert.equal(merged.find((s) => s.kind === "layout")?.ok, undefined);
});
