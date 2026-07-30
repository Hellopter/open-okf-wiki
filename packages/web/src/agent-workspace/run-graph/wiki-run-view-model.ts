/**
 * Pure projection: WikiRunSnapshot (ADR 0035 control plane) → Run Graph
 * view-model the canvas renders directly.
 *
 * Product path: WikiRunSnapshot → wikiRunToViewModel → RunGraphCanvas.
 * No dual hop through RunGraphSnapshot for live UI.
 */

import type {
  ErrorClass,
  GraphNodeKind,
  NodeAttempt,
  NodeAttemptStatus,
  WikiRunAttempt,
  WikiRunAttemptState,
  WikiRunGate,
  WikiRunNode,
  WikiRunNodeKind,
  WikiRunNodeState,
  WikiRunSnapshot,
} from "@okf-wiki/contract";
import {
  appendOrphanAttemptNodes,
  edgesFromNodes,
  groupViewNodesIntoLayers,
  layerForKind,
  latestAttemptFor,
  type RunGraphViewModel,
  type RunGraphViewNode,
} from "./view-model.ts";

/** ErrorClass values accepted on NodeAttempt (Run Graph observation). */
const NODE_ATTEMPT_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "transient",
  "schema",
  "quality",
  "policy",
  "budget",
  "needs_input",
  "capacity",
  "infrastructure",
]);

export type WikiRunFailedNode = {
  node: WikiRunNode;
  attempt: WikiRunAttempt;
};

export type WikiRunGraphViewModel = RunGraphViewModel & {
  /** Open plan/publication/operator_input gates from the durable snapshot. */
  openGates: WikiRunGate[];
  /** Nodes whose current/last attempt is failed or interrupted (retry targets). */
  failedNodes: WikiRunFailedNode[];
  runState: WikiRunSnapshot["state"];
  revision: number;
};

function graphKindFor(kind: WikiRunNodeKind): GraphNodeKind {
  switch (kind) {
    case "plan":
    case "gate.plan":
      return "plan";
    case "research.domain":
      return "domain";
    case "research.leaf":
      return "leaf";
    case "write.root":
      return "write";
    case "review.seat":
    case "review.reduce":
    case "gate.fix":
      return "review";
    case "repair":
      return "repair";
    case "validate.pre":
    case "validate.final":
    case "freeze":
      return "validate";
    case "prepare.publication":
    case "gate.publication":
    case "publish":
      return "publish";
    default:
      return "validate";
  }
}

/** Prefer control-plane projected label; fall back to key tail only if absent. */
function labelFor(node: WikiRunNode): string {
  const projected = node.label?.trim();
  if (projected) return projected;
  const key = node.key;
  const short = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  return short || key;
}

export function attemptStatusFromWiki(state: WikiRunAttemptState): NodeAttemptStatus {
  switch (state) {
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
    case "interrupted":
      return "error";
    case "suspended":
      return "awaiting";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

/** Map node control state to chip status when no attempt is present. */
export function nodeStatusFromWiki(state: WikiRunNodeState): NodeAttemptStatus | "idle" {
  switch (state) {
    case "ready":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "awaiting";
    case "succeeded":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "invalidated":
      return "skipped";
    case "blocked":
    default:
      return "idle";
  }
}

export function projectWikiAttempt(attempt: WikiRunAttempt): NodeAttempt {
  const errorClass =
    attempt.failureClass && NODE_ATTEMPT_ERROR_CLASSES.has(attempt.failureClass)
      ? (attempt.failureClass as ErrorClass)
      : undefined;
  return {
    attemptId: attempt.attemptId,
    nodeKey: attempt.nodeKey,
    runIndex: Math.max(0, attempt.runIndex - 1),
    status: attemptStatusFromWiki(attempt.state),
    startedAt: attempt.startedAt,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.error ? { summary: attempt.error } : {}),
    ...(errorClass ? { errorClass } : {}),
  };
}

/** Playhead: prefer running, else suspended, else latest by runIndex. */
function playheadFromWikiAttempts(
  attempts: readonly WikiRunAttempt[],
): { nodeKey: string; attemptId: string } | undefined {
  if (attempts.length === 0) return undefined;
  const ranked = [...attempts].sort((a, b) => b.runIndex - a.runIndex);
  const live =
    ranked.find((a) => a.state === "running") ??
    ranked.find((a) => a.state === "suspended") ??
    ranked[0];
  if (!live) return undefined;
  return { nodeKey: live.nodeKey, attemptId: live.attemptId };
}

export function openGatesFromSnapshot(snapshot: WikiRunSnapshot): WikiRunGate[] {
  return snapshot.gates.filter((gate) => gate.state === "open");
}

/**
 * Failed/interrupted attempts that are still the node's current generation
 * target for RetryFailedNode (generation + attemptId CAS).
 */
export function failedNodesFromSnapshot(snapshot: WikiRunSnapshot): WikiRunFailedNode[] {
  const byId = new Map(snapshot.attempts.map((a) => [a.attemptId, a]));
  const out: WikiRunFailedNode[] = [];
  for (const node of snapshot.nodes) {
    if (node.state !== "failed") continue;
    const attemptId = node.currentAttemptId ?? node.lastAttemptId;
    if (!attemptId) continue;
    const attempt = byId.get(attemptId);
    if (!attempt) continue;
    if (attempt.state !== "failed" && attempt.state !== "interrupted") continue;
    if (attempt.nodeGeneration !== node.generation) continue;
    out.push({ node, attempt });
  }
  return out;
}

/**
 * Direct product projection: WikiRunSnapshot → canvas view-model.
 * Builds layers from nodes + attempts without RunGraphSnapshot intermediate.
 */
export function wikiRunToViewModel(snapshot: WikiRunSnapshot): WikiRunGraphViewModel {
  const attempts = snapshot.attempts.map(projectWikiAttempt);

  const nodes: RunGraphViewNode[] = snapshot.nodes.map((node) => {
    const kind = graphKindFor(node.kind);
    const latest = latestAttemptFor(node.key, attempts);
    const attemptCount = attempts.filter((a) => a.nodeKey === node.key).length;
    return {
      nodeKey: node.key,
      kind,
      label: labelFor(node),
      layer: layerForKind(kind),
      ...(node.parentKey ? { parentKey: node.parentKey } : {}),
      ...(latest ? { latestAttempt: latest } : {}),
      attemptCount,
      // Overlay control-plane node state when no attempt exists yet.
      status: latest ? latest.status : nodeStatusFromWiki(node.state),
    };
  });

  appendOrphanAttemptNodes(nodes, attempts);

  const playhead = playheadFromWikiAttempts(snapshot.attempts);

  return {
    layers: groupViewNodesIntoLayers(nodes),
    edges: edgesFromNodes(nodes),
    attempts,
    ...(playhead ? { playhead } : {}),
    topologyVersion: snapshot.revision,
    openGates: openGatesFromSnapshot(snapshot),
    failedNodes: failedNodesFromSnapshot(snapshot),
    runState: snapshot.state,
    revision: snapshot.revision,
  };
}
