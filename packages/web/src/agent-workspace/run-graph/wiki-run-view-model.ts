/**
 * Pure projection: WikiRunSnapshot (ADR 0035 control plane) → Run Graph
 * observation shapes the existing canvas understands.
 *
 * WikiRuns nodes/attempts are the durable truth; legacy analysis/run-graph.json
 * is optional read-only history and is not required for live Run UI.
 */

import type {
  GraphNodeKind,
  NodeAttempt,
  NodeAttemptStatus,
  RunGraphSnapshot,
  WikiRunAttempt,
  WikiRunAttemptState,
  WikiRunGate,
  WikiRunNode,
  WikiRunNodeKind,
  WikiRunNodeState,
  WikiRunSnapshot,
} from "@okf-wiki/contract";
import {
  type RunGraphViewModel,
  type RunGraphViewNode,
  runGraphToViewModel,
} from "./view-model.ts";

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
  return {
    attemptId: attempt.attemptId,
    nodeKey: attempt.nodeKey,
    runIndex: Math.max(0, attempt.runIndex - 1),
    status: attemptStatusFromWiki(attempt.state),
    startedAt: attempt.startedAt,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
    ...(attempt.error ? { summary: attempt.error } : {}),
  };
}

/**
 * Project durable WikiRuns nodes + attempts into the legacy RunGraphSnapshot
 * shape so RunGraphCanvas / runGraphToViewModel stay reusable.
 */
export function wikiRunSnapshotToRunGraph(snapshot: WikiRunSnapshot): RunGraphSnapshot {
  const topology = snapshot.nodes.map((node) => ({
    nodeKey: node.key,
    kind: graphKindFor(node.kind),
    label: labelFor(node),
    ...(node.parentKey ? { parentKey: node.parentKey } : {}),
  }));

  const attempts = snapshot.attempts.map(projectWikiAttempt);

  // Playhead: prefer a running attempt, else a suspended/waiting one, else latest by runIndex.
  let playhead: RunGraphSnapshot["playhead"];
  const ranked = [...snapshot.attempts].sort((a, b) => b.runIndex - a.runIndex);
  const live =
    ranked.find((a) => a.state === "running") ??
    ranked.find((a) => a.state === "suspended") ??
    ranked[0];
  if (live) {
    playhead = { nodeKey: live.nodeKey, attemptId: live.attemptId };
  }

  return {
    topologyVersion: snapshot.revision,
    topology,
    attempts,
    ...(playhead ? { playhead } : {}),
  };
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

/** Full canvas + HITL helpers from one durable snapshot. */
export function wikiRunToViewModel(snapshot: WikiRunSnapshot): WikiRunGraphViewModel {
  const graph = wikiRunSnapshotToRunGraph(snapshot);
  const base = runGraphToViewModel(graph);

  // Overlay control-plane node state when a node has no attempts yet.
  const nodeByKey = new Map(snapshot.nodes.map((n) => [n.key, n]));
  const layers = base.layers.map((layer) => ({
    id: layer.id,
    nodes: layer.nodes.map((viewNode: RunGraphViewNode): RunGraphViewNode => {
      if (viewNode.latestAttempt) return viewNode;
      const control = nodeByKey.get(viewNode.nodeKey);
      if (!control) return viewNode;
      return {
        ...viewNode,
        status: nodeStatusFromWiki(control.state),
      };
    }),
  }));

  return {
    ...base,
    layers,
    openGates: openGatesFromSnapshot(snapshot),
    failedNodes: failedNodesFromSnapshot(snapshot),
    runState: snapshot.state,
    revision: snapshot.revision,
  };
}
