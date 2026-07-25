/**
 * Pure view-model: RunGraphSnapshot → layered nodes/edges for read-only canvas.
 * Depends only on @okf-wiki/contract.
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

export type RunGraphViewEdge = {
  id: string;
  from: string;
  to: string;
  kind: "parent" | "depends";
};

export type RunGraphViewModel = {
  layers: Array<{ id: RunGraphLayerId; nodes: RunGraphViewNode[] }>;
  edges: RunGraphViewEdge[];
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

function layerForKind(kind: GraphNodeKind): RunGraphLayerId {
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

function latestAttemptFor(
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

function statusFromAttempt(attempt?: NodeAttempt): NodeAttemptStatus | "idle" {
  return attempt?.status ?? "idle";
}

/**
 * Project a contract RunGraphSnapshot into layered canvas nodes + edges.
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

  // Orphan attempts (no topology node) still appear as synthetic nodes.
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

  const edges: RunGraphViewEdge[] = [];
  for (const def of snapshot.topology) {
    if (def.parentKey) {
      edges.push({
        id: `p:${def.parentKey}->${def.nodeKey}`,
        from: def.parentKey,
        to: def.nodeKey,
        kind: "parent",
      });
    }
    for (const dep of def.dependsOn ?? []) {
      edges.push({
        id: `d:${dep}->${def.nodeKey}`,
        from: dep,
        to: def.nodeKey,
        kind: "depends",
      });
    }
  }

  const byLayer = new Map<RunGraphLayerId, RunGraphViewNode[]>();
  for (const id of LAYER_ORDER) byLayer.set(id, []);
  for (const node of nodes) {
    byLayer.get(node.layer)!.push(node);
  }
  const layers = LAYER_ORDER.filter((id) => (byLayer.get(id)?.length ?? 0) > 0).map((id) => ({
    id,
    nodes: byLayer.get(id)!,
  }));

  return {
    layers,
    edges,
    attempts,
    ...(snapshot.playhead ? { playhead: snapshot.playhead } : {}),
    topologyVersion: snapshot.topologyVersion,
  };
}
