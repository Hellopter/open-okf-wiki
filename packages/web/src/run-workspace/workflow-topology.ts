import {
  stageForNodeKind,
  type WikiRunNode,
  type WikiRunSnapshot,
} from "@okf-wiki/contract/wiki-runs";

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

/** Lightweight scout receipt projection for display nodes (plan-review or metrics). */
export type PlanScoutDisplay = {
  kind: string;
  ok?: boolean;
  preview?: string;
  relPath?: string;
};

export const PLAN_SCOUT_KEY_PREFIX = "plan.scout.";

export const workflowStageIds: WorkflowStageId[] = [
  "plan",
  "research",
  "synthesis",
  "quality",
  "publication",
];

/** Map contract observation stages onto the operator canvas stage ids. */
function canvasStageFromObservation(stage: ReturnType<typeof stageForNodeKind>): WorkflowStageId {
  switch (stage) {
    case "plan":
      return "plan";
    case "research":
      return "research";
    case "write":
      return "synthesis";
    case "review":
    case "repair":
    case "validate":
      return "quality";
    case "publish":
    case "gate":
      // gate.plan is "gate" in contract; keep plan-adjacent gates on plan via kind check below.
      return "publication";
    default:
      return "publication";
  }
}

export function stageForNode(node: WikiRunNode): WorkflowStageId {
  // Plan gate stays in plan stage (operator canvas grouping).
  if (node.kind === "gate.plan") return "plan";
  if (node.kind === "gate.fix") return "quality";
  if (node.kind === "validate.pre") return "synthesis";
  return canvasStageFromObservation(stageForNodeKind(node.kind));
}

/** Filesystem-safe slug for plan.scout.<slug> display keys. */
export function planScoutSlug(kind: string): string {
  return (
    kind
      .trim()
      .replace(/\\/g, "/")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "scout"
  );
}

export function planScoutNodeKey(kind: string): string {
  return `${PLAN_SCOUT_KEY_PREFIX}${planScoutSlug(kind)}`;
}

export function isPlanScoutNodeKey(key: string | null | undefined): boolean {
  return Boolean(key?.startsWith(PLAN_SCOUT_KEY_PREFIX));
}

export function planScoutKindFromKey(key: string): string {
  return key.startsWith(PLAN_SCOUT_KEY_PREFIX) ? key.slice(PLAN_SCOUT_KEY_PREFIX.length) : key;
}

/** True when the control-plane snapshot already has durable plan.scout nodes. */
export function hasDurablePlanScouts(
  nodes: ReadonlyArray<Pick<WikiRunNode, "key" | "kind">>,
): boolean {
  return nodes.some(
    (node) => node.kind === "plan.scout" || node.key.startsWith(PLAN_SCOUT_KEY_PREFIX),
  );
}

/**
 * Read scout kinds from the latest succeeded/running plan attempt metrics.extra.
 * Soft: missing or malformed extra never throws.
 * Prefer durable snapshot plan.scout nodes — this is only a fallback for old runs.
 */
export function scoutKindsFromSnapshot(snapshot: WikiRunSnapshot): string[] {
  // Durable plan.scout.* nodes own topology; do not also project metrics.extra.
  if (hasDurablePlanScouts(snapshot.nodes)) return [];

  const planAttempts = snapshot.attempts
    .filter((attempt) => attempt.nodeKey === "plan")
    .slice()
    .sort(
      (a, b) =>
        a.nodeGeneration - b.nodeGeneration ||
        a.runIndex - b.runIndex ||
        a.startedAt.localeCompare(b.startedAt),
    );
  for (let i = planAttempts.length - 1; i >= 0; i -= 1) {
    const extra = planAttempts[i]?.metrics?.extra;
    if (!extra || typeof extra !== "object") continue;
    const raw = (extra as Record<string, unknown>).scoutKinds;
    if (!Array.isArray(raw)) continue;
    const kinds = raw
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 32);
    if (kinds.length > 0) return kinds;
  }
  return [];
}

/**
 * Project display-only plan.scout nodes into a topology for **legacy** runs that
 * nested scouts under the plan attempt (no durable DAG nodes). Prefer durable
 * snapshot nodes — this helper is a no-op when plan.scout already exists.
 */
export function injectPlanScoutDisplayNodes(
  nodes: WikiRunNode[],
  edges: Array<{ id: string; source: string; target: string; relation: WorkflowEdgeRelation }>,
  scouts: PlanScoutDisplay[],
  planNode: WikiRunNode,
): {
  nodes: WikiRunNode[];
  edges: Array<{ id: string; source: string; target: string; relation: WorkflowEdgeRelation }>;
} {
  if (scouts.length === 0) return { nodes, edges };

  const existingKeys = new Set(nodes.map((node) => node.key));
  // Durable graph already has plan.scout — never double-inject from metrics/review.
  if (hasDurablePlanScouts(nodes)) {
    return { nodes, edges };
  }

  const mirrorState = (ok: boolean | undefined): WikiRunNode["state"] => {
    if (ok === false) return "failed";
    if (planNode.state === "failed") return "failed";
    if (planNode.state === "running" || planNode.state === "ready") return planNode.state;
    if (planNode.state === "succeeded") return "succeeded";
    if (planNode.state === "waiting") return "waiting";
    if (planNode.state === "invalidated") return "invalidated";
    if (planNode.state === "cancelled") return "cancelled";
    return planNode.state;
  };

  const scoutNodes: WikiRunNode[] = scouts.map((scout) => {
    const key = planScoutNodeKey(scout.kind);
    return {
      key,
      kind: "plan.scout" as const,
      label: `Scout · ${scout.kind}`,
      state: mirrorState(scout.ok),
      generation: planNode.generation,
      currentAttemptId: null,
      lastAttemptId: null,
      outputs: [],
      parentKey: planNode.key,
      ...(scout.relPath ? { detail: { scope: scout.relPath } } : {}),
    };
  });

  // Prefer unique keys (dedupe kinds that slug-collide).
  const seen = new Set<string>();
  const uniqueScouts = scoutNodes.filter((node) => {
    if (seen.has(node.key) || existingKeys.has(node.key)) return false;
    seen.add(node.key);
    return true;
  });
  if (uniqueScouts.length === 0) return { nodes, edges };

  const scoutKeys = new Set(uniqueScouts.map((node) => node.key));
  // Drop direct plan → gate.plan (or other plan children in-stage) so fan-out
  // goes through scouts; rewire consumers onto scout join edges.
  const nextEdges = edges.filter((edge) => {
    if (edge.source === planNode.key && !scoutKeys.has(edge.target)) {
      // Keep non-gate fan-out (e.g. research leaves in research focus); only
      // rewire edges whose target is still in the plan stage or is gate.plan.
      const target = nodes.find((n) => n.key === edge.target);
      if (target && (target.kind === "gate.plan" || target.kind === "plan.scout")) return false;
      if (edge.target === "gate.plan") return false;
    }
    return true;
  });

  const joinTargets = new Set<string>();
  for (const edge of edges) {
    if (edge.source !== planNode.key) continue;
    const target = nodes.find((n) => n.key === edge.target);
    if (target?.kind === "gate.plan" || edge.target === "gate.plan") {
      joinTargets.add(edge.target);
    }
  }
  // Fallback: if plan has no outgoing gate edge in this topology, still fan out.
  if (joinTargets.size === 0) {
    const gate = nodes.find((n) => n.kind === "gate.plan" || n.key === "gate.plan");
    if (gate) joinTargets.add(gate.key);
  }

  for (const scout of uniqueScouts) {
    nextEdges.push({
      id: `${planNode.key}->${scout.key}`,
      source: planNode.key,
      target: scout.key,
      relation: "fanout",
    });
    for (const target of joinTargets) {
      nextEdges.push({
        id: `${scout.key}->${target}`,
        source: scout.key,
        target,
        relation: "join",
      });
    }
  }

  return {
    nodes: [...nodes, ...uniqueScouts],
    edges: nextEdges,
  };
}

/**
 * Merge plan-review scouts with snapshot metrics scoutKinds (review wins on ok/preview).
 */
export function mergePlanScoutDisplays(
  fromReview: PlanScoutDisplay[] | undefined,
  fromMetrics: string[],
): PlanScoutDisplay[] {
  const bySlug = new Map<string, PlanScoutDisplay>();
  for (const kind of fromMetrics) {
    const slug = planScoutSlug(kind);
    if (!bySlug.has(slug)) bySlug.set(slug, { kind });
  }
  for (const scout of fromReview ?? []) {
    bySlug.set(planScoutSlug(scout.kind), scout);
  }
  return [...bySlug.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Build a synthetic WikiRunNode for observation when the key is a display scout. */
export function syntheticPlanScoutNode(
  nodeKey: string,
  planNode: WikiRunNode | undefined,
  scout: PlanScoutDisplay | undefined,
): WikiRunNode {
  const kind = scout?.kind ?? planScoutKindFromKey(nodeKey);
  const baseState: WikiRunNode["state"] =
    scout?.ok === false
      ? "failed"
      : planNode?.state === "failed"
        ? "failed"
        : planNode?.state === "succeeded"
          ? "succeeded"
          : planNode?.state === "running"
            ? "running"
            : "succeeded";
  return {
    key: nodeKey,
    kind: "plan.scout",
    label: `Scout · ${kind}`,
    state: baseState,
    generation: planNode?.generation ?? 0,
    currentAttemptId: null,
    lastAttemptId: null,
    outputs: [],
    parentKey: "plan",
    ...(scout?.relPath ? { detail: { scope: scout.relPath } } : {}),
  };
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
  // Durable: freeze → plan.scout.* → plan; legacy inject: plan → plan.scout → gate.plan
  if (source.kind === "freeze" && target.kind === "plan.scout") return "fanout";
  if (source.kind === "plan" && target.kind === "plan.scout") return "fanout";
  if (source.kind === "plan.scout" && target.kind === "plan") return "join";
  if (source.kind === "plan.scout" && target.kind.startsWith("gate.")) return "join";
  if (source.kind === "plan.scout") return "join";
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
export function researchDomainLeafGroups(topology: FocusTopology): Map<string, string[]> {
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

/** Kind rank for non-research pipeline nodes (after domain clusters). */
function layoutTailKindRank(kind: string): number {
  if (kind === "plan.adapt") return 0;
  if (kind === "write.root" || kind === "validate.pre") return 1;
  if (kind === "review.seat" || kind === "review.reduce") return 2;
  if (kind === "gate.fix" || kind === "repair" || kind === "validate.final") return 3;
  return 4;
}

/**
 * Stable ELK model order: plan boundary → per-domain leaf clusters → orphans →
 * adapt / write / quality / publication. When `expandedDomainKeys` is provided
 * (collapse active), only expanded domains place their leaves before the domain
 * card; collapsed domains contribute the domain alone.
 */
export function orderedNodesForLayout(
  topology: FocusTopology,
  options?: { expandedDomainKeys?: ReadonlySet<string> },
): WikiRunNode[] {
  const byKey = new Map(topology.nodes.map((node) => [node.key, node]));
  const remaining = new Set(topology.nodes.map((node) => node.key));
  const ordered: WikiRunNode[] = [];

  const take = (key: string) => {
    if (!remaining.has(key)) return;
    const node = byKey.get(key);
    if (!node) return;
    remaining.delete(key);
    ordered.push(node);
  };

  // Durable topology: freeze → plan.scout.* → plan → gate.plan (edges from snapshot).
  // Legacy display inject: plan → plan.scout → gate — place scouts after plan then.
  const byKeyForPlan = byKey;
  const durableScoutOrder = topology.edges.some((edge) => {
    const source = byKeyForPlan.get(edge.source);
    const target = byKeyForPlan.get(edge.target);
    return (
      (source?.kind === "freeze" && target?.kind === "plan.scout") ||
      (source?.kind === "plan.scout" && target?.kind === "plan")
    );
  });

  const freezeNodes = topology.nodes
    .filter((node) => node.kind === "freeze")
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const node of freezeNodes) take(node.key);

  const planScouts = topology.nodes
    .filter((node) => node.kind === "plan.scout")
    .sort((a, b) => a.key.localeCompare(b.key));
  const planNodes = topology.nodes
    .filter((node) => node.kind === "plan")
    .sort((a, b) => a.key.localeCompare(b.key));

  if (durableScoutOrder) {
    for (const node of planScouts) take(node.key);
    for (const node of planNodes) take(node.key);
  } else {
    for (const node of planNodes) take(node.key);
    for (const node of planScouts) take(node.key);
  }

  const planGates = topology.nodes
    .filter((node) => node.kind === "gate.plan")
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const node of planGates) take(node.key);

  const groups = researchDomainLeafGroups(topology);
  const collapseActive = options?.expandedDomainKeys !== undefined;
  const domains = topology.nodes
    .filter((node) => node.kind === "research.domain")
    .sort((a, b) => a.key.localeCompare(b.key));

  // When collapse is active, place expanded domain clusters first so partial
  // expand stays contiguous; both groups remain alpha-sorted within themselves.
  const orderedDomains = collapseActive
    ? [
        ...domains.filter((domain) => options?.expandedDomainKeys?.has(domain.key)),
        ...domains.filter((domain) => !options?.expandedDomainKeys?.has(domain.key)),
      ]
    : domains;

  for (const domain of orderedDomains) {
    const expanded = !collapseActive || (options?.expandedDomainKeys?.has(domain.key) ?? false);
    if (expanded) {
      for (const leafKey of groups.get(domain.key) ?? []) take(leafKey);
    }
    take(domain.key);
  }

  const orphans = [...remaining]
    .map((key) => byKey.get(key)!)
    .filter((node) => node.kind === "research.leaf")
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const node of orphans) take(node.key);

  const tail = [...remaining]
    .map((key) => byKey.get(key)!)
    .sort(
      (a, b) =>
        layoutTailKindRank(a.kind) - layoutTailKindRank(b.kind) || a.key.localeCompare(b.key),
    );
  for (const node of tail) take(node.key);

  return ordered;
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
