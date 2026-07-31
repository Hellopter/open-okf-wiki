/**
 * Shared layered canvas view-model primitives for durable WikiRuns.
 * Depends only on @okf-wiki/contract.
 *
 * Product canvas path uses WikiRunSnapshot → wikiRunToViewModel. Durable
 * WikiRuns exposes its own DAG; this module only supplies shared projection
 * helpers for that one model.
 */

import type { GraphNodeKind, NodeAttempt, NodeAttemptStatus } from "@okf-wiki/contract";

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
  from: string;
  to: string;
};

export type RunGraphViewModel = {
  layers: Array<{ id: RunGraphLayerId; nodes: RunGraphViewNode[] }>;
  /** Directed dependencies whose endpoints exist in the snapshot. */
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
    node.parentKey && known.has(node.parentKey) ? [{ from: node.parentKey, to: node.nodeKey }] : [],
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
