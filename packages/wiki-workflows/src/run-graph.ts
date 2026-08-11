/**
 * Run graph helpers: phase membership, fork/invalidate closure, terminal checks.
 *
 * Pure module: no @earendil-works/* or executor imports.
 */

import { latestPhaseIteration } from "./phase-iterations.js";
import { clone } from "./util.js";
import { phaseTitleForKind } from "./workflow-phases.js";
import {
  EMPTY_NODE_METRICS,
  type WikiNode,
  type WikiNodeKind,
  type WikiRunSnapshot,
} from "./workflow-types.js";

export function nodesInPhase(run: WikiRunSnapshot, phaseId: string): WikiNode[] {
  const explicit = latestPhaseIteration(run.nodes, phaseId);
  if (explicit.length) return explicit;
  const legacyNodeId = phaseId.startsWith("phase:") ? phaseId.slice("phase:".length) : "";
  const start = run.nodes.findIndex((node) => node.id === legacyNodeId);
  if (start < 0) return [];
  const kind = run.nodes[start]?.kind;
  const nodes: WikiNode[] = [];
  for (const node of run.nodes.slice(start)) {
    if (node.phaseId || node.kind !== kind) break;
    nodes.push(node);
  }
  return nodes;
}

/** Retry only independent roots; successful roots deterministically derive the rest of the phase. */
export function phaseRetryRoots(nodes: WikiNode[]): WikiNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const roots = nodes.filter((node) => !node.dependsOn.some((dependency) => nodeIds.has(dependency)));
  return roots.length ? roots : [nodes[0]!];
}

export function affectedNodeIds(run: WikiRunSnapshot, rootIds: string[]): Set<string> {
  const affected = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (affected.has(node.id) || !node.dependsOn.some((id) => affected.has(id))) continue;
      affected.add(node.id);
      changed = true;
    }
  }
  return affected;
}

export function resetForkedNode(node: WikiNode, at: string): void {
  node.status = "invalidated";
  node.attempt = 0;
  node.attemptHistory = [];
  node.result = undefined;
  node.output = undefined;
  node.history = undefined;
  node.handoff = undefined;
  node.error = undefined;
  node.metrics = clone(EMPTY_NODE_METRICS);
  node.startedAt = undefined;
  node.finishedAt = undefined;
  node.activity = { state: "idle", message: "Forked retry", updatedAt: at };
}

export function phaseTitle(node: WikiNode | undefined): string {
  return node?.phaseTitle ?? (node ? phaseTitleFor(node.kind) : "phase");
}

/** User-visible phase title for a node kind (synthesis → Plan, verify kinds → Verify). */
export function phaseTitleFor(kind: WikiNodeKind): string {
  return phaseTitleForKind(kind);
}

export function isTerminalRun(snapshot: WikiRunSnapshot): boolean {
  return snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "blocked" || snapshot.status === "cancelled";
}

/** History that may be forked: terminal runs, or interrupted (paused/running on disk). */
export function isForkableRun(snapshot: WikiRunSnapshot): boolean {
  return isTerminalRun(snapshot) || snapshot.status === "paused" || snapshot.status === "running";
}
