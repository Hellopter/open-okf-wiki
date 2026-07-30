/**
 * Pure view-model: RunGraphSnapshot → layered nodes for read-only canvas.
 * Depends only on @okf-wiki/contract.
 *
 * Product canvas path uses WikiRunSnapshot → wikiRunToViewModel (no dual hop).
 * runGraphToViewModel remains for unit tests / legacy snapshot shapes.
 *
 * Edges are not projected here — the canvas is a layered chip grid; parent
 * hierarchy is available on each node via `parentKey` when needed.
 */

import type {
  GraphNodeDef,
  GraphNodeKind,
  NodeAttempt,
  NodeAttemptStatus,
  RunGraphSnapshot,
} from "@okf-wiki/contract";

export type RunGraphLayerId =
  | "plan"
  | "research"
  | "write"
  | "review"
  | "repair"
  | "validate"
  | "publish"
  | "other";

export type RunGraphViewNode = {
  nodeKey: string;
  kind: GraphNodeKind;
  label: string;
  layer: RunGraphLayerId;
  parentKey?: string;
  /** Latest attempt for this nodeKey (by runIndex, then endedAt). */
  latestAttempt?: NodeAttempt;
  attemptCount: number;
  status: NodeAttemptStatus | "idle";
};

/** A contract-provided parent relationship. No dependency is inferred by the UI. */
export type RunGraphEdge = {
  parentKey: string;
  childKey: string;
};

export type RunGraphViewModel = {
  layers: Array<{ id: RunGraphLayerId; nodes: RunGraphViewNode[] }>;
  /** Only parentKey relationships whose endpoints exist in the snapshot. */
  edges: RunGraphEdge[];
  attempts: NodeAttempt[];
  playhead?: { nodeKey: string; attemptId: string };
  topologyVersion: number;
};

const LAYER_ORDER: RunGraphLayerId[] = [
  "plan",
  "research",
  "write",
  "review",
  "repair",
  "validate",
  "publish",
  "other",
];

export function layerForKind(kind: GraphNodeKind): RunGraphLayerId {
  switch (kind) {
    case "plan":
      return "plan";
    case "domain":
    case "leaf":
      return "research";
    case "write":
      return "write";
    case "review":
      return "review";
    case "repair":
      return "repair";
    case "validate":
      return "validate";
    case "publish":
      return "publish";
    default:
      return "other";
  }
}

export function latestAttemptFor(
  nodeKey: string,
  attempts: readonly NodeAttempt[],
): NodeAttempt | undefined {
  const forNode = attempts.filter((a) => a.nodeKey === nodeKey);
  if (forNode.length === 0) return undefined;
  return forNode.reduce((best, cur) => {
    if (cur.runIndex > best.runIndex) return cur;
    if (cur.runIndex < best.runIndex) return best;
    const be = best.endedAt ?? best.startedAt ?? "";
    const ce = cur.endedAt ?? cur.startedAt ?? "";
    return ce >= be ? cur : best;
  });
}

export function statusFromAttempt(attempt?: NodeAttempt): NodeAttemptStatus | "idle" {
  return attempt?.status ?? "idle";
}

/** Bucket view-nodes into non-empty ordered layers. */
export function groupViewNodesIntoLayers(
  nodes: readonly RunGraphViewNode[],
): Array<{ id: RunGraphLayerId; nodes: RunGraphViewNode[] }> {
  const byLayer = new Map<RunGraphLayerId, RunGraphViewNode[]>();
  for (const id of LAYER_ORDER) byLayer.set(id, []);
  for (const node of nodes) {
    byLayer.get(node.layer)!.push(node);
  }
  return LAYER_ORDER.filter((id) => (byLayer.get(id)?.length ?? 0) > 0).map((id) => ({
    id,
    nodes: byLayer.get(id)!,
  }));
}

/**
 * Project explicit hierarchy only. `dependsOn` is deliberately not rendered
 * here because the durable snapshot does not expose that relationship.
 */
export function edgesFromNodes(nodes: readonly RunGraphViewNode[]): RunGraphEdge[] {
  const known = new Set(nodes.map((node) => node.nodeKey));
  return nodes.flatMap((node) =>
    node.parentKey && known.has(node.parentKey)
      ? [{ parentKey: node.parentKey, childKey: node.nodeKey }]
      : [],
  );
}

/**
 * Append synthetic nodes for attempts whose nodeKey is not already present.
 * Orphans land in layer "other" with kind "validate" (canvas chip fallback).
 */
export function appendOrphanAttemptNodes(
  nodes: RunGraphViewNode[],
  attempts: readonly NodeAttempt[],
): void {
  const known = new Set(nodes.map((n) => n.nodeKey));
  for (const attempt of attempts) {
    if (known.has(attempt.nodeKey)) continue;
    known.add(attempt.nodeKey);
    const latest = latestAttemptFor(attempt.nodeKey, attempts);
    nodes.push({
      nodeKey: attempt.nodeKey,
      kind: "validate",
      label: attempt.role ?? attempt.nodeKey,
      layer: "other",
      ...(latest ? { latestAttempt: latest } : {}),
      attemptCount: attempts.filter((a) => a.nodeKey === attempt.nodeKey).length,
      status: statusFromAttempt(latest),
    });
  }
}

/**
 * Project a contract RunGraphSnapshot into layered canvas nodes.
 * Prefer wikiRunToViewModel for product WikiRuns UI.
 */
export function runGraphToViewModel(snapshot: RunGraphSnapshot): RunGraphViewModel {
  const attempts = [...snapshot.attempts];
  const nodes: RunGraphViewNode[] = snapshot.topology.map((def: GraphNodeDef) => {
    const latest = latestAttemptFor(def.nodeKey, attempts);
    const attemptCount = attempts.filter((a) => a.nodeKey === def.nodeKey).length;
    return {
      nodeKey: def.nodeKey,
      kind: def.kind,
      label: def.label,
      layer: layerForKind(def.kind),
      ...(def.parentKey ? { parentKey: def.parentKey } : {}),
      ...(latest ? { latestAttempt: latest } : {}),
      attemptCount,
      status: statusFromAttempt(latest),
    };
  });

  appendOrphanAttemptNodes(nodes, attempts);

  return {
    layers: groupViewNodesIntoLayers(nodes),
    edges: edgesFromNodes(nodes),
    attempts,
    ...(snapshot.playhead ? { playhead: snapshot.playhead } : {}),
    topologyVersion: snapshot.topologyVersion,
  };
}
