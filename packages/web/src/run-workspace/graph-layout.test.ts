import assert from "node:assert/strict";
import test from "node:test";
import type { WikiRunNode } from "@okf-wiki/contract";
import {
  contentNodeHeight,
  FOCUS_NODE_HEIGHT,
  FOCUS_NODE_WIDTH,
  layoutResearchFocus,
  packPositionsByModelOrder,
  RESEARCH_FOCUS_DOMAIN_GAP,
  RESEARCH_FOCUS_LAYER_GAP,
  RESEARCH_FOCUS_LEAF_GAP,
} from "./graph-layout.ts";

function layoutNode(key: string, kind: string, generation = 0): WikiRunNode {
  return {
    key,
    kind: kind as WikiRunNode["kind"],
    label: key,
    state: "succeeded" as WikiRunNode["state"],
    generation,
  };
}

test("packPositionsByModelOrder restacks a layer into model order top-to-bottom", () => {
  // Simulates ELK placing other domains above expanded leaves in the same X column.
  const orderedNodeKeys = ["leaf.a", "leaf.b", "domain.expanded", "domain.other", "domain.z"];
  const height = 72;
  const positions = {
    "domain.other": { x: 400, y: 12 },
    "domain.z": { x: 401, y: 160 },
    "leaf.a": { x: 400, y: 399 },
    "leaf.b": { x: 405, y: 520 },
    "domain.expanded": { x: 398, y: 640 },
  };
  const heightByNode = Object.fromEntries(orderedNodeKeys.map((key) => [key, height]));

  const packed = packPositionsByModelOrder(orderedNodeKeys, positions, heightByNode, 56);

  // Same approximate layer; model order becomes top-to-bottom.
  const layerOrder = orderedNodeKeys.slice().sort((a, b) => packed[a]!.y - packed[b]!.y);
  assert.deepEqual(layerOrder, orderedNodeKeys);

  // Stacked with height + gap from the layer's original min y.
  assert.equal(packed["leaf.a"]!.y, 12);
  assert.equal(packed["leaf.b"]!.y, 12 + height + 56);
  assert.equal(packed["domain.expanded"]!.y, 12 + 2 * (height + 56));
  assert.equal(packed["domain.other"]!.y, 12 + 3 * (height + 56));
  assert.equal(packed["domain.z"]!.y, 12 + 4 * (height + 56));

  // X unchanged.
  for (const key of orderedNodeKeys) {
    assert.equal(packed[key]!.x, positions[key as keyof typeof positions].x);
  }
});

test("packPositionsByModelOrder leaves single-node layers at original y", () => {
  const positions = {
    plan: { x: 0, y: 120 },
    write: { x: 800, y: 40 },
  };
  const orderedNodeKeys = ["plan", "write"];
  const packed = packPositionsByModelOrder(orderedNodeKeys, positions, {
    plan: FOCUS_NODE_HEIGHT,
    write: FOCUS_NODE_HEIGHT,
  });

  assert.equal(packed.plan!.x, 0);
  assert.equal(packed.plan!.y, 120);
  assert.equal(packed.write!.x, 800);
  assert.equal(packed.write!.y, 40);
});

test("packPositionsByModelOrder accepts Map heights and independent layers", () => {
  const orderedNodeKeys = ["a", "b", "c"];
  const positions = {
    a: { x: 0, y: 50 },
    b: { x: 200, y: 10 },
    c: { x: 200, y: 300 },
  };
  // b should go above c even though ELK put c lower — model order a, b, c
  // but a is a different layer; within x≈200, order is b then c.
  const heights = new Map([
    ["a", 80],
    ["b", 100],
    ["c", 60],
  ]);
  const packed = packPositionsByModelOrder(orderedNodeKeys, positions, heights, 40);

  assert.equal(packed.a!.y, 50);
  assert.equal(packed.b!.y, 10);
  assert.equal(packed.c!.y, 10 + 100 + 40);
  assert.ok(packed.b!.y < packed.c!.y);
});

test("layoutResearchFocus partial expand keeps leaves aligned with their domain", () => {
  // Model order: plan → expanded domain A leaves+domain → collapsed domain B → adapt → write
  const plan = layoutNode("plan", "plan");
  const leafA1 = layoutNode("research.leaf.a.1", "research.leaf");
  const leafA2 = layoutNode("research.leaf.a.2", "research.leaf");
  const leafA3 = layoutNode("research.leaf.a.3", "research.leaf");
  const domainA = layoutNode("research.domain.a", "research.domain");
  const domainB = layoutNode("research.domain.b", "research.domain");
  const adapt = layoutNode("plan.adapt.1", "plan.adapt");
  const write = layoutNode("write.root", "write.root");

  const orderedNodes = [plan, leafA1, leafA2, leafA3, domainA, domainB, adapt, write];
  const domainGroups = new Map<string, string[]>([
    ["research.domain.a", ["research.leaf.a.1", "research.leaf.a.2", "research.leaf.a.3"]],
    ["research.domain.b", ["research.leaf.b.1", "research.leaf.b.2", "research.leaf.b.3"]],
  ]);
  const expandedDomainKeys = new Set(["research.domain.a"]);
  const domainCollapseKeys = new Set(["research.domain.a", "research.domain.b"]);

  const positions = layoutResearchFocus(orderedNodes, [], {
    domainGroups,
    expandedDomainKeys,
    domainCollapseKeys,
  });

  const leafX = FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;
  const domainX = leafX + FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;
  const tailX = domainX + FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;

  // Column geometry
  assert.equal(positions.plan!.x, 0);
  assert.equal(positions["research.leaf.a.1"]!.x, leafX);
  assert.equal(positions["research.leaf.a.2"]!.x, leafX);
  assert.equal(positions["research.leaf.a.3"]!.x, leafX);
  assert.equal(positions["research.domain.a"]!.x, domainX);
  assert.equal(positions["research.domain.b"]!.x, domainX);
  assert.equal(positions["plan.adapt.1"]!.x, tailX);
  assert.equal(positions["write.root"]!.x, tailX);

  // Collapsed domain B has no leaves in the graph
  assert.equal(positions["research.leaf.b.1"], undefined);

  const leafH = contentNodeHeight(leafA1);
  const domainAH = contentNodeHeight(domainA, { domainCollapseChrome: true });
  const domainBH = contentNodeHeight(domainB, { domainCollapseChrome: true });

  // Leaves stacked with leaf gap
  assert.equal(positions["research.leaf.a.1"]!.y, 0);
  assert.equal(positions["research.leaf.a.2"]!.y, leafH + RESEARCH_FOCUS_LEAF_GAP);
  assert.equal(positions["research.leaf.a.3"]!.y, 2 * (leafH + RESEARCH_FOCUS_LEAF_GAP));

  const leafStackTop = positions["research.leaf.a.1"]!.y;
  const leafStackBottom = positions["research.leaf.a.3"]!.y + leafH;
  const domainATop = positions["research.domain.a"]!.y;
  const domainABottom = domainATop + domainAH;

  // Domain A y-range overlaps the leaf stack (mid-aligned, not inverted).
  assert.ok(
    domainATop < leafStackBottom && domainABottom > leafStackTop,
    `domain A [${domainATop},${domainABottom}] should overlap leaves [${leafStackTop},${leafStackBottom}]`,
  );
  const leafMid = (leafStackTop + leafStackBottom) / 2;
  const domainMid = domainATop + domainAH / 2;
  assert.ok(Math.abs(leafMid - domainMid) < 1e-6, "domain A centered on its leaves");

  // Domain B (collapsed) sits below A's cluster, not interleaved mid-leaves.
  const clusterBottom = Math.max(leafStackBottom, domainABottom);
  assert.ok(
    positions["research.domain.b"]!.y >= clusterBottom + RESEARCH_FOCUS_DOMAIN_GAP - 1e-6,
    "collapsed domain B must be below expanded cluster A",
  );
  assert.equal(positions["research.domain.b"]!.y, clusterBottom + RESEARCH_FOCUS_DOMAIN_GAP);

  // B is a single card (height only domain chrome height)
  assert.ok(positions["research.domain.b"]!.y + domainBH > positions["research.domain.b"]!.y);
});

test("layoutResearchFocus all-collapsed stacks domains only", () => {
  const plan = layoutNode("plan", "plan");
  const domainA = layoutNode("research.domain.a", "research.domain");
  const domainB = layoutNode("research.domain.b", "research.domain");
  const write = layoutNode("write.root", "write.root");

  const orderedNodes = [plan, domainA, domainB, write];
  const domainGroups = new Map<string, string[]>([
    ["research.domain.a", ["research.leaf.a.1", "research.leaf.a.2"]],
    ["research.domain.b", ["research.leaf.b.1"]],
  ]);

  const positions = layoutResearchFocus(orderedNodes, [], {
    domainGroups,
    expandedDomainKeys: new Set(),
    domainCollapseKeys: new Set(["research.domain.a", "research.domain.b"]),
  });

  const domainX =
    FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP + FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;
  assert.equal(positions["research.domain.a"]!.x, domainX);
  assert.equal(positions["research.domain.b"]!.x, domainX);
  assert.equal(positions["research.domain.a"]!.y, 0);

  const domainAH = contentNodeHeight(domainA, { domainCollapseChrome: true });
  assert.equal(positions["research.domain.b"]!.y, domainAH + RESEARCH_FOCUS_DOMAIN_GAP);
  assert.ok(positions["research.domain.a"]!.y < positions["research.domain.b"]!.y);
  assert.equal(Object.keys(positions).filter((k) => k.includes("leaf")).length, 0);
});
