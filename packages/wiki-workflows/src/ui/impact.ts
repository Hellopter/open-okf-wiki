import { latestPhaseIteration } from "../phase-iterations.js";
import type { WikiNode, WikiRunSnapshot } from "../workflow-types.js";
import type { WikiRunView } from "./stages.js";

export interface WikiRetryImpact {
  targetId: string;
  targetIds: string[];
  phaseId?: string;
  preservedUpstream: string[];
  invalidatedDownstream: string[];
  writesWiki: boolean;
  rechecksGit: true;
}

export function retryImpact(run: WikiRunView, targetId: string): WikiRetryImpact | undefined {
  const target = nodeById(run, targetId);
  if (!target) return undefined;
  return retryImpactFor(run, [targetId], targetId);
}

export function phaseRetryImpact(run: WikiRunView, phaseId: string): WikiRetryImpact | undefined {
  const nodes = latestPhaseIteration(run.nodes, phaseId);
  if (!nodes.length) return undefined;
  const nodeIds = nodes.map((node) => node.id);
  return retryImpactFor(run, nodeIds, nodeIds[0]!, phaseId);
}

function retryImpactFor(run: WikiRunView, targetIds: string[], targetId: string, phaseId?: string): WikiRetryImpact {
  const targetSet = new Set(targetIds);
  const upstream = new Set<string>();
  for (const id of targetIds) for (const upstreamId of upstreamIds(run, id)) upstream.add(upstreamId);
  const downstream = downstreamIds(run, targetIds);
  const affected = [...targetIds, ...downstream];
  return {
    targetId,
    targetIds,
    phaseId,
    preservedUpstream: [...upstream].filter((id) => !targetSet.has(id)),
    invalidatedDownstream: [...downstream],
    writesWiki: affected.some((id) => {
      const kind = nodeById(run, id)?.kind;
      return kind === "write" || kind === "repair";
    }),
    rechecksGit: true,
  };
}

export function describeNodes(run: WikiRunSnapshot, ids: string[]): string {
  return ids.map((id) => nodeById(run, id)?.label ?? id).join(", ");
}

function nodeById(run: WikiRunView, id: string): WikiNode | undefined {
  return run.nodes.find((node) => node.id === id);
}

function upstreamIds(run: WikiRunView, targetId: string): Set<string> {
  const ids = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of nodeById(run, id)?.dependsOn ?? []) {
      if (ids.has(dependency)) continue;
      ids.add(dependency);
      visit(dependency);
    }
  };
  visit(targetId);
  return ids;
}

function downstreamIds(run: WikiRunView, targetIds: string[]): Set<string> {
  const ids = new Set<string>(targetIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (ids.has(node.id) || !node.dependsOn.some((dep) => ids.has(dep))) continue;
      ids.add(node.id);
      changed = true;
    }
  }
  return new Set(
    run.nodes
      .filter((node) => ids.has(node.id) && !targetIds.includes(node.id))
      .map((node) => node.id),
  );
}
