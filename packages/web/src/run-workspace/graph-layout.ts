import type { WikiRunNode } from "@okf-wiki/contract";
import type { FocusTopology } from "./workflow-topology";

/**
 * Pure focus-graph layout helpers (sizes, edge simplification, handle plan, ELK options).
 * Content-sized cards only — never inflate height by incident degree (avoids Plan towers).
 */

export const FOCUS_NODE_WIDTH = 220;
export const FOCUS_NODE_HEIGHT = 72;
/** Hard cap so multi-handle fan-out stays dense instead of growing empty towers. */
export const MAX_FOCUS_NODE_HEIGHT = 120;
/** Extra room for domain expand/collapse chrome; still subject to MAX_FOCUS_NODE_HEIGHT. */
export const DOMAIN_COLLAPSE_CHROME = 28;

export type TopologyEdge = FocusTopology["edges"][number];

export type HandlePlan = {
  sourceHandleByEdge: Map<string, string>;
  targetHandleByEdge: Map<string, string>;
  sourceHandleIdsByNode: Map<string, string[]>;
  targetHandleIdsByNode: Map<string, string[]>;
  heightByNode: Map<string, number>;
};

export function baseNodeHeight(node: WikiRunNode): number {
  return node.generation > 0 ? FOCUS_NODE_HEIGHT + 14 : FOCUS_NODE_HEIGHT;
}

/**
 * Content-based height only. Domain collapse chrome adds a small bump; never degree×slot.
 */
export function contentNodeHeight(
  node: WikiRunNode,
  options?: { domainCollapseChrome?: boolean },
): number {
  let height = baseNodeHeight(node);
  if (options?.domainCollapseChrome) {
    height += DOMAIN_COLLAPSE_CHROME;
  }
  return Math.min(MAX_FOCUS_NODE_HEIGHT, height);
}

export function degreeMaps(edges: TopologyEdge[]): {
  outDegree: Map<string, number>;
  inDegree: Map<string, number>;
} {
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }
  return { outDegree, inDegree };
}

/**
 * Drop length-2 transitive forward edges for display (A→C when A→B→C exists).
 * Keeps the real control-plane snapshot intact; only the React Flow projection
 * simplifies so domain→write does not pile on top of domain→adapt→write.
 */
export function simplifyDisplayEdges(edges: TopologyEdge[]): TopologyEdge[] {
  const adj = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = adj.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    adj.set(edge.source, targets);
  }
  return edges.filter((edge) => {
    if (edge.relation === "feedback" || edge.relation === "control") return true;
    for (const mid of adj.get(edge.source) ?? []) {
      if (mid === edge.target) continue;
      if (adj.get(mid)?.has(edge.target)) return false;
    }
    return true;
  });
}

/**
 * After ELK places nodes, bind each edge to a dedicated handle ordered by the
 * counterpart's Y. That turns center-bundled fan-out into parallel orthogonal runs
 * (React Flow multi-handle + ELK model-order pattern).
 */
export function buildHandlePlan(
  topology: FocusTopology,
  positions: Record<string, { x: number; y: number }>,
  options?: { domainCollapseKeys?: ReadonlySet<string> },
): HandlePlan {
  const heightByNode = new Map<string, number>();
  for (const node of topology.nodes) {
    heightByNode.set(
      node.key,
      contentNodeHeight(node, {
        domainCollapseChrome:
          node.kind === "research.domain" && (options?.domainCollapseKeys?.has(node.key) ?? false),
      }),
    );
  }

  const bySource = new Map<string, TopologyEdge[]>();
  const byTarget = new Map<string, TopologyEdge[]>();
  for (const edge of topology.edges) {
    const outs = bySource.get(edge.source) ?? [];
    outs.push(edge);
    bySource.set(edge.source, outs);
    const ins = byTarget.get(edge.target) ?? [];
    ins.push(edge);
    byTarget.set(edge.target, ins);
  }

  const yOf = (key: string) => positions[key]?.y ?? 0;

  const sourceHandleByEdge = new Map<string, string>();
  const targetHandleByEdge = new Map<string, string>();
  const sourceHandleIdsByNode = new Map<string, string[]>();
  const targetHandleIdsByNode = new Map<string, string[]>();

  for (const node of topology.nodes) {
    const outs = [...(bySource.get(node.key) ?? [])].sort(
      (a, b) => yOf(a.target) - yOf(b.target) || a.target.localeCompare(b.target),
    );
    const ins = [...(byTarget.get(node.key) ?? [])].sort(
      (a, b) => yOf(a.source) - yOf(b.source) || a.source.localeCompare(b.source),
    );
    const sourceIds = outs.length > 0 ? outs.map((_, i) => `out-${i}`) : ["out-0"];
    const targetIds = ins.length > 0 ? ins.map((_, i) => `in-${i}`) : ["in-0"];
    sourceHandleIdsByNode.set(node.key, sourceIds);
    targetHandleIdsByNode.set(node.key, targetIds);
    outs.forEach((edge, i) => sourceHandleByEdge.set(edge.id, `out-${i}`));
    ins.forEach((edge, i) => targetHandleByEdge.set(edge.id, `in-${i}`));
  }

  return {
    sourceHandleByEdge,
    targetHandleByEdge,
    sourceHandleIdsByNode,
    targetHandleIdsByNode,
    heightByNode,
  };
}

export function elkLayoutOptions(nodeCount: number): Record<string, string> {
  const dense = nodeCount > 10;
  return {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": dense ? "72" : "56",
    "elk.spacing.edgeNode": dense ? "32" : "24",
    "elk.spacing.edgeEdge": dense ? "18" : "14",
    "elk.spacing.portPort": "12",
    "elk.layered.spacing.nodeNodeBetweenLayers": dense ? "140" : "110",
    "elk.layered.spacing.edgeNodeBetweenLayers": "32",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "20",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.considerModelOrder.portModelOrder": "true",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.layered.nodePlacement.favorStraightEdges": "true",
    "elk.layered.unnecessaryBendpoints": "true",
  };
}

export type ElkLayoutChild = {
  id: string;
  width: number;
  height: number;
  ports: Array<{
    id: string;
    width: number;
    height: number;
    layoutOptions: Record<string, string>;
  }>;
  layoutOptions: Record<string, string>;
};

export type ElkLayoutEdge = {
  id: string;
  sources: string[];
  targets: string[];
};

/** Build ELK children/edges using layout order as model order. */
export function buildElkLayoutInput(
  orderedNodes: WikiRunNode[],
  displayEdges: TopologyEdge[],
  options?: {
    outDegree?: Map<string, number>;
    inDegree?: Map<string, number>;
    domainCollapseKeys?: ReadonlySet<string>;
  },
): { children: ElkLayoutChild[]; edges: ElkLayoutEdge[] } {
  const { outDegree, inDegree } =
    options?.outDegree && options?.inDegree
      ? { outDegree: options.outDegree, inDegree: options.inDegree }
      : degreeMaps(displayEdges);

  const children = orderedNodes.map((node) => {
    const height = contentNodeHeight(node, {
      domainCollapseChrome:
        node.kind === "research.domain" && (options?.domainCollapseKeys?.has(node.key) ?? false),
    });
    const portCountOut = Math.max(outDegree.get(node.key) ?? 0, 1);
    const portCountIn = Math.max(inDegree.get(node.key) ?? 0, 1);
    const ports = [
      ...Array.from({ length: portCountIn }, (_, i) => ({
        id: `${node.key}:in-${i}`,
        width: 6,
        height: 6,
        layoutOptions: { "elk.port.side": "WEST", "elk.port.index": String(i) },
      })),
      ...Array.from({ length: portCountOut }, (_, i) => ({
        id: `${node.key}:out-${i}`,
        width: 6,
        height: 6,
        layoutOptions: { "elk.port.side": "EAST", "elk.port.index": String(i) },
      })),
    ];
    return {
      id: node.key,
      width: FOCUS_NODE_WIDTH,
      height,
      ports,
      layoutOptions: {
        "elk.portConstraints": "FIXED_ORDER",
      },
    };
  });

  const orderIndex = new Map(orderedNodes.map((node, index) => [node.key, index]));
  const edges = [...displayEdges].sort((a, b) => {
    const sa = orderIndex.get(a.source) ?? 0;
    const sb = orderIndex.get(b.source) ?? 0;
    return sa - sb || a.target.localeCompare(b.target);
  });

  const outIndex = new Map<string, number>();
  const inIndex = new Map<string, number>();
  const elkEdges = edges.map((edge) => {
    const oi = outIndex.get(edge.source) ?? 0;
    outIndex.set(edge.source, oi + 1);
    const ii = inIndex.get(edge.target) ?? 0;
    inIndex.set(edge.target, ii + 1);
    return {
      id: edge.id,
      sources: [`${edge.source}:out-${oi}`],
      targets: [`${edge.target}:in-${ii}`],
    };
  });

  return { children, edges: elkEdges };
}

export function allNodesPositioned(
  nodeKeys: readonly string[],
  positions: Record<string, { x: number; y: number }>,
): boolean {
  return nodeKeys.length > 0 && nodeKeys.every((key) => positions[key] != null);
}

/** Snap ELK x into approximate layer buckets (same column ≈ same layer). */
const LAYER_X_BUCKET = 40;

/**
 * Post-ELK vertical pack: within each approximate X layer, restack nodes in
 * model order (orderedNodeKeys) so expanded domain clusters stay above other
 * domains even when ELK's crossing minimizer reorders within the layer.
 * Keeps x unchanged; single-node layers stay at their original y.
 */
export function packPositionsByModelOrder(
  orderedNodeKeys: string[],
  positions: Record<string, { x: number; y: number }>,
  heightByNode: Record<string, number> | Map<string, number>,
  gap = 56,
): Record<string, { x: number; y: number }> {
  const orderIndex = new Map(orderedNodeKeys.map((key, index) => [key, index]));
  const heightOf = (key: string): number => {
    if (heightByNode instanceof Map) {
      return heightByNode.get(key) ?? FOCUS_NODE_HEIGHT;
    }
    return heightByNode[key] ?? FOCUS_NODE_HEIGHT;
  };

  const layers = new Map<number, string[]>();
  for (const key of Object.keys(positions)) {
    const bucket = Math.round(positions[key]!.x / LAYER_X_BUCKET) * LAYER_X_BUCKET;
    const group = layers.get(bucket) ?? [];
    group.push(key);
    layers.set(bucket, group);
  }

  const packed: Record<string, { x: number; y: number }> = {};
  for (const layerKeys of layers.values()) {
    layerKeys.sort((a, b) => {
      const ia = orderIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
      const ib = orderIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ia - ib || a.localeCompare(b);
    });
    const minY = Math.min(...layerKeys.map((key) => positions[key]!.y));
    let y = Number.isFinite(minY) ? minY : 0;
    for (const key of layerKeys) {
      packed[key] = { x: positions[key]!.x, y };
      y += heightOf(key) + gap;
    }
  }
  return packed;
}

/** Horizontal gap between focus columns (plan | leaves | domains | tail). */
export const RESEARCH_FOCUS_LAYER_GAP = 140;
/** Vertical gap between stacked leaves under an expanded domain. */
export const RESEARCH_FOCUS_LEAF_GAP = 40;
/** Vertical gap between domain blocks (collapsed cards or expanded clusters). */
export const RESEARCH_FOCUS_DOMAIN_GAP = 56;

function isPlanBoundaryKind(kind: string): boolean {
  return kind === "freeze" || kind === "plan" || kind === "gate.plan";
}

/**
 * Deterministic research-stage focus layout when domain collapse is active.
 * Leaves and their domain sit in adjacent columns with aligned Y clusters so
 * partial expand never inverts (ELK Y + per-layer pack cannot keep clusters).
 *
 * Columns LEFT→RIGHT: plan/context → leaves → domains → tail (adapt/write/…).
 * `edges` is accepted for API symmetry with other layout helpers; placement is
 * driven by orderedNodes + domainGroups.
 */
export function layoutResearchFocus(
  orderedNodes: WikiRunNode[],
  _edges: TopologyEdge[],
  options: {
    domainGroups: Map<string, string[]>;
    expandedDomainKeys: ReadonlySet<string>;
    domainCollapseKeys?: ReadonlySet<string>;
  },
): Record<string, { x: number; y: number }> {
  const leafX = FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;
  const domainX = leafX + FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;
  const tailX = domainX + FOCUS_NODE_WIDTH + RESEARCH_FOCUS_LAYER_GAP;

  const byKey = new Map(orderedNodes.map((node) => [node.key, node]));
  const present = new Set(orderedNodes.map((node) => node.key));

  const heightOf = (node: WikiRunNode): number =>
    contentNodeHeight(node, {
      domainCollapseChrome:
        node.kind === "research.domain" && (options.domainCollapseKeys?.has(node.key) ?? false),
    });

  const positions: Record<string, { x: number; y: number }> = {};
  const placed = new Set<string>();

  const place = (key: string, x: number, y: number) => {
    positions[key] = { x, y };
    placed.add(key);
  };

  // Domains appear in orderedNodes already expanded-first then alpha within group.
  const domains = orderedNodes.filter((node) => node.kind === "research.domain");

  // Leaf keys that belong to any domain group (may be hidden when collapsed).
  const groupedLeafKeys = new Set<string>();
  for (const leaves of options.domainGroups.values()) {
    for (const leaf of leaves) groupedLeafKeys.add(leaf);
  }

  let cursorY = 0;

  for (const domain of domains) {
    const expanded = options.expandedDomainKeys.has(domain.key);
    const leafKeys = (options.domainGroups.get(domain.key) ?? []).filter((key) => present.has(key));
    const domainH = heightOf(domain);

    if (expanded && leafKeys.length > 0) {
      let leafY = cursorY;
      let stackTop = leafY;
      let stackBottom = leafY;
      for (let i = 0; i < leafKeys.length; i++) {
        const leaf = byKey.get(leafKeys[i]!);
        if (!leaf) continue;
        const h = heightOf(leaf);
        place(leaf.key, leafX, leafY);
        if (i === 0) stackTop = leafY;
        stackBottom = leafY + h;
        leafY += h + RESEARCH_FOCUS_LEAF_GAP;
      }
      const stackMid = (stackTop + stackBottom) / 2;
      const domainY = stackMid - domainH / 2;
      place(domain.key, domainX, domainY);
      const blockBottom = Math.max(stackBottom, domainY + domainH);
      cursorY = blockBottom + RESEARCH_FOCUS_DOMAIN_GAP;
    } else {
      place(domain.key, domainX, cursorY);
      cursorY += domainH + RESEARCH_FOCUS_DOMAIN_GAP;
    }
  }

  // Orphan research leaves (present but not under a domain group).
  const orphanLeaves = orderedNodes.filter(
    (node) =>
      node.kind === "research.leaf" && !groupedLeafKeys.has(node.key) && !placed.has(node.key),
  );
  for (const leaf of orphanLeaves) {
    const h = heightOf(leaf);
    place(leaf.key, leafX, cursorY);
    cursorY += h + RESEARCH_FOCUS_LEAF_GAP;
  }

  // Any domain-grouped leaves still unplaced (defensive).
  for (const node of orderedNodes) {
    if (node.kind !== "research.leaf" || placed.has(node.key)) continue;
    const h = heightOf(node);
    place(node.key, leafX, cursorY);
    cursorY += h + RESEARCH_FOCUS_LEAF_GAP;
  }

  // Content bounds from research stack (domains + leaves).
  let contentTop = 0;
  let contentBottom = 0;
  let hasContent = false;
  for (const key of placed) {
    const node = byKey.get(key);
    if (!node) continue;
    const pos = positions[key]!;
    const bottom = pos.y + heightOf(node);
    if (!hasContent) {
      contentTop = pos.y;
      contentBottom = bottom;
      hasContent = true;
    } else {
      contentTop = Math.min(contentTop, pos.y);
      contentBottom = Math.max(contentBottom, bottom);
    }
  }
  const contentHeight = hasContent ? contentBottom - contentTop : 0;

  const stackColumn = (nodes: WikiRunNode[], x: number, gap: number) => {
    if (nodes.length === 0) return;
    const heights = nodes.map(heightOf);
    const stackH = heights.reduce((sum, h) => sum + h, 0) + Math.max(0, nodes.length - 1) * gap;
    let y = contentTop + (contentHeight - stackH) / 2;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      place(node.key, x, y);
      y += heights[i]! + gap;
    }
  };

  const planNodes = orderedNodes.filter(
    (node) => isPlanBoundaryKind(node.kind) && !placed.has(node.key),
  );
  stackColumn(planNodes, 0, RESEARCH_FOCUS_DOMAIN_GAP);

  const tailNodes = orderedNodes.filter((node) => !placed.has(node.key));
  stackColumn(tailNodes, tailX, RESEARCH_FOCUS_DOMAIN_GAP);

  return positions;
}
