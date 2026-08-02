import type { WikiRunNode, WikiRunSnapshot } from "@okf-wiki/contract";

export type WorkflowStageId = "plan" | "research" | "synthesis" | "quality" | "publication";
export type WorkflowEdgeRelation = "forward" | "fanout" | "join" | "control" | "feedback";

export type WorkflowStage = {
  id: WorkflowStageId;
  label: string;
  nodes: WikiRunNode[];
  state: string;
  completed: number;
  total: number;
};

export type FocusTopology = {
  nodes: WikiRunNode[];
  edges: Array<{ id: string; source: string; target: string; relation: WorkflowEdgeRelation }>;
  /** Nodes immediately outside the selected stage, retained for real joins and loops. */
  contextNodeKeys: ReadonlySet<string>;
  topologyKey: string;
};

export const workflowStageIds: WorkflowStageId[] = [
  "plan",
  "research",
  "synthesis",
  "quality",
  "publication",
];

export function stageForNode(node: WikiRunNode): WorkflowStageId {
  if (["freeze", "plan", "gate.plan"].includes(node.kind)) return "plan";
  if (["research.leaf", "research.domain", "plan.adapt"].includes(node.kind)) return "research";
  if (["write.root", "validate.pre"].includes(node.kind)) return "synthesis";
  if (["review.seat", "review.reduce", "gate.fix", "repair", "validate.final"].includes(node.kind))
    return "quality";
  return "publication";
}

function aggregateState(nodes: WikiRunNode[]): string {
  if (nodes.some((node) => node.state === "running")) return "running";
  if (nodes.some((node) => node.state === "failed")) return "failed";
  if (nodes.some((node) => node.state === "waiting")) return "waiting";
  if (nodes.length > 0 && nodes.every((node) => node.state === "succeeded")) return "succeeded";
  if (nodes.some((node) => node.state === "ready")) return "ready";
  return "blocked";
}

export function buildWorkflowStages(
  snapshot: WikiRunSnapshot,
  labels: Record<WorkflowStageId, string>,
): WorkflowStage[] {
  return workflowStageIds.map((id) => {
    const nodes = snapshot.nodes.filter((node) => stageForNode(node) === id);
    return {
      id,
      label: labels[id],
      nodes,
      state: aggregateState(nodes),
      completed: nodes.filter((node) => node.state === "succeeded").length,
      total: nodes.length,
    };
  });
}

export function relationForEdge(source: WikiRunNode, target: WikiRunNode): WorkflowEdgeRelation {
  if (source.kind === "repair" && target.kind === "validate.pre") return "feedback";
  if (source.kind.startsWith("gate.") || target.kind.startsWith("gate.")) return "control";
  if (target.kind === "research.leaf" || target.kind === "review.seat") return "fanout";
  if (
    source.kind === "research.leaf" ||
    source.kind === "research.domain" ||
    source.kind === "review.seat"
  )
    return "join";
  return "forward";
}

export function buildFocusTopology(
  snapshot: WikiRunSnapshot,
  stage: WorkflowStageId,
): FocusTopology {
  const focusKeys = new Set(
    snapshot.nodes.filter((node) => stageForNode(node) === stage).map((node) => node.key),
  );
  const byKey = new Map(snapshot.nodes.map((node) => [node.key, node]));
  const visibleKeys = new Set(focusKeys);

  // A focused stage remains connected to its immediate boundary. That retains
  // the real plan fan-out/research fan-in and the repair-to-validation loop.
  for (const edge of snapshot.edges) {
    if (focusKeys.has(edge.from) !== focusKeys.has(edge.to)) {
      visibleKeys.add(edge.from);
      visibleKeys.add(edge.to);
    }
  }

  const nodes = snapshot.nodes.filter((node) => visibleKeys.has(node.key));
  const edges = snapshot.edges
    .filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to))
    .map((edge) => ({
      id: `${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      relation: relationForEdge(byKey.get(edge.from)!, byKey.get(edge.to)!),
    }));
  return {
    nodes,
    edges,
    contextNodeKeys: new Set(
      nodes.filter((node) => !focusKeys.has(node.key)).map((node) => node.key),
    ),
    topologyKey: JSON.stringify({
      stage,
      nodes: nodes.map((node) => [
        node.key,
        node.kind,
        node.label,
        node.generation,
        focusKeys.has(node.key),
      ]),
      edges: edges.map((edge) => [edge.source, edge.target, edge.relation]),
    }),
  };
}

/** domain key → sorted research.leaf keys that join into it. */
export function researchDomainLeafGroups(
  topology: FocusTopology,
): Map<string, string[]> {
  const byKey = new Map(topology.nodes.map((node) => [node.key, node]));
  const groups = new Map<string, string[]>();
  for (const edge of topology.edges) {
    const source = byKey.get(edge.source);
    const target = byKey.get(edge.target);
    if (source?.kind !== "research.leaf" || target?.kind !== "research.domain") continue;
    const leaves = groups.get(target.key) ?? [];
    if (!leaves.includes(source.key)) leaves.push(source.key);
    groups.set(target.key, leaves);
  }
  for (const [domain, leaves] of groups) {
    groups.set(
      domain,
      [...leaves].sort((a, b) => a.localeCompare(b)),
    );
  }
  return groups;
}

/** Collapse only when fan-out is dense enough that domain cards are clearer. */
export function shouldCollapseResearchLeaves(topology: FocusTopology): boolean {
  const groups = researchDomainLeafGroups(topology);
  let leafCount = 0;
  for (const leaves of groups.values()) leafCount += leaves.length;
  return groups.size >= 2 && leafCount >= 5;
}

/**
 * Hide research.leaf nodes under collapsed domains and rewire their inbound
 * edges onto the domain (plan → domain) so the stage stays connected.
 * Expanded domains keep full leaf fan-out. Pure projection — does not mutate snapshot.
 */
export function projectCollapsedResearchLeaves(
  topology: FocusTopology,
  expandedDomainKeys: ReadonlySet<string>,
): FocusTopology {
  if (!shouldCollapseResearchLeaves(topology)) return topology;

  const groups = researchDomainLeafGroups(topology);
  const hiddenLeaves = new Set<string>();
  for (const [domain, leaves] of groups) {
    if (expandedDomainKeys.has(domain)) continue;
    for (const leaf of leaves) hiddenLeaves.add(leaf);
  }
  if (hiddenLeaves.size === 0) return topology;

  const byKey = new Map(topology.nodes.map((node) => [node.key, node]));
  const leafDomain = new Map<string, string>();
  for (const [domain, leaves] of groups) {
    for (const leaf of leaves) leafDomain.set(leaf, domain);
  }

  const nodes = topology.nodes.filter((node) => !hiddenLeaves.has(node.key));
  const visibleKeys = new Set(nodes.map((node) => node.key));
  const edges: FocusTopology["edges"] = [];
  const seen = new Set<string>();

  for (const edge of topology.edges) {
    if (hiddenLeaves.has(edge.source) || hiddenLeaves.has(edge.target)) continue;
    edges.push(edge);
    seen.add(edge.id);
  }

  for (const leaf of hiddenLeaves) {
    const domain = leafDomain.get(leaf);
    if (!domain || !visibleKeys.has(domain)) continue;
    for (const edge of topology.edges) {
      if (edge.target !== leaf) continue;
      if (hiddenLeaves.has(edge.source) || !visibleKeys.has(edge.source)) continue;
      if (edge.source === domain) continue;
      const id = `${edge.source}->${domain}`;
      if (seen.has(id)) continue;
      const sourceNode = byKey.get(edge.source);
      const domainNode = byKey.get(domain);
      if (!sourceNode || !domainNode) continue;
      edges.push({
        id,
        source: edge.source,
        target: domain,
        relation: relationForEdge(sourceNode, domainNode),
      });
      seen.add(id);
    }
  }

  return {
    nodes,
    edges,
    contextNodeKeys: topology.contextNodeKeys,
    topologyKey: JSON.stringify({
      base: topology.topologyKey,
      expanded: [...expandedDomainKeys].sort(),
      hidden: [...hiddenLeaves].sort(),
    }),
  };
}
