/**
 * Client best-effort eligibility for RetryFailedNode / RerunNode.
 * Server remains authoritative; these helpers only gate the operator UI.
 */

import type { WikiRunAttempt, WikiRunNode, WikiRunSnapshot } from "@okf-wiki/contract";

export type RetryReasonKey =
  | "runPublished"
  | "runCancelled"
  | "nodeNotFound"
  | "nodeNotFailed"
  | "nodeCancelled"
  | "nodeInvalidated"
  | "attemptMissing"
  | "attemptNotRetryable"
  | "freezeNotPinned"
  | "hasConsumers";

export type RerunReasonKey =
  | "runPublished"
  | "runCancelled"
  | "nodeNotFound"
  | "repairNode"
  | "planMaterialized";

export type RetryEligibility =
  | { ok: true; attemptId: string; generation: number }
  | { ok: false; reasonKey: RetryReasonKey };

export type RerunEligibility =
  | { ok: true; generation: number; warnConsumers?: boolean }
  | { ok: false; reasonKey: RerunReasonKey };

/** Product repair node keys: `repair.1`, `repair.2`, … (matches workflow isRepairNodeKey). */
export function isRepairNodeKey(nodeKey: string): boolean {
  return /^repair\.\d+$/.test(nodeKey);
}

function findNode(snapshot: WikiRunSnapshot, nodeKey: string): WikiRunNode | undefined {
  return snapshot.nodes.find((node) => node.key === nodeKey);
}

function lastAttemptForNode(snapshot: WikiRunSnapshot, node: WikiRunNode): WikiRunAttempt | null {
  if (node.lastAttemptId) {
    const byId = snapshot.attempts.find((attempt) => attempt.attemptId === node.lastAttemptId);
    if (byId) return byId;
  }
  const matching = snapshot.attempts
    .filter((attempt) => attempt.nodeKey === node.key && attempt.nodeGeneration === node.generation)
    .sort((left, right) => right.runIndex - left.runIndex);
  return matching[0] ?? null;
}

function runBlocksRecovery(snapshot: WikiRunSnapshot): "runPublished" | "runCancelled" | null {
  if (snapshot.state === "published") return "runPublished";
  if (snapshot.state === "cancelled" || snapshot.cancelRequested) return "runCancelled";
  return null;
}

/**
 * Best-effort: edges + successor progress. Snapshot does not expose attempt_inputs
 * lineage, so this can false-positive/negative; server enforces the real closure.
 */
export function hasLikelyDownstreamConsumers(snapshot: WikiRunSnapshot, nodeKey: string): boolean {
  const node = findNode(snapshot, nodeKey);
  const successors = snapshot.edges
    .filter((edge) => edge.from === nodeKey)
    .map((edge) => findNode(snapshot, edge.to))
    .filter((item): item is WikiRunNode => Boolean(item));

  if (successors.length === 0) return false;

  // Sealed outputs + any progressed successor ≈ likely consumption.
  if (node && node.outputs.length > 0) {
    return successors.some(
      (successor) =>
        successor.lastAttemptId != null ||
        ["running", "succeeded", "failed", "waiting", "ready"].includes(successor.state),
    );
  }

  return successors.some(
    (successor) =>
      successor.lastAttemptId != null ||
      ["running", "succeeded", "failed", "waiting"].includes(successor.state),
  );
}

/** True once execution nodes beyond freeze / plan / gate.plan exist. */
export function hasMaterializedExecutionTopology(snapshot: WikiRunSnapshot): boolean {
  return snapshot.nodes.some((node) => !["freeze", "plan", "gate.plan"].includes(node.key));
}

/**
 * Same-generation retry of a failed/interrupted attempt when no downstream
 * consumers bound this generation's outputs.
 */
export function canRetryFailedNode(snapshot: WikiRunSnapshot, nodeKey: string): RetryEligibility {
  const blocked = runBlocksRecovery(snapshot);
  if (blocked) return { ok: false, reasonKey: blocked };

  const node = findNode(snapshot, nodeKey);
  if (!node) return { ok: false, reasonKey: "nodeNotFound" };
  if (node.state === "cancelled") return { ok: false, reasonKey: "nodeCancelled" };
  if (node.state === "invalidated") return { ok: false, reasonKey: "nodeInvalidated" };
  if (node.state !== "failed") return { ok: false, reasonKey: "nodeNotFailed" };

  const attempt = lastAttemptForNode(snapshot, node);
  if (!attempt) return { ok: false, reasonKey: "attemptMissing" };
  if (!["failed", "interrupted"].includes(attempt.state)) {
    return { ok: false, reasonKey: "attemptNotRetryable" };
  }

  // Pre-pin freeze has no immutable inputs; server rejects same-digest retry.
  if (nodeKey === "freeze" && snapshot.pinnedInputs === null) {
    return { ok: false, reasonKey: "freezeNotPinned" };
  }

  if (node.outputs.length > 0 && hasLikelyDownstreamConsumers(snapshot, nodeKey)) {
    return { ok: false, reasonKey: "hasConsumers" };
  }

  return {
    ok: true,
    attemptId: attempt.attemptId,
    generation: node.generation,
  };
}

/**
 * Generation++ rerun (invalidates lineage consumers). Soft-warns when consumers
 * would cascade. Plan is hard-disabled once execution topology is materialized.
 */
export function canRerunNode(snapshot: WikiRunSnapshot, nodeKey: string): RerunEligibility {
  const blocked = runBlocksRecovery(snapshot);
  if (blocked) return { ok: false, reasonKey: blocked };

  const node = findNode(snapshot, nodeKey);
  if (!node) return { ok: false, reasonKey: "nodeNotFound" };
  if (isRepairNodeKey(nodeKey)) return { ok: false, reasonKey: "repairNode" };
  // Server hard-rejects plan rerun once non-bootstrap nodes exist.
  if (nodeKey === "plan" && hasMaterializedExecutionTopology(snapshot)) {
    return { ok: false, reasonKey: "planMaterialized" };
  }

  const warnConsumers = hasLikelyDownstreamConsumers(snapshot, nodeKey);

  return {
    ok: true,
    generation: node.generation,
    ...(warnConsumers ? { warnConsumers: true as const } : {}),
  };
}

/** Nodes whose current generation looks retry-eligible. */
export function listRetryableNodeKeys(snapshot: WikiRunSnapshot): string[] {
  return snapshot.nodes
    .filter((node) => canRetryFailedNode(snapshot, node.key).ok)
    .map((node) => node.key);
}

/** Nodes failed or with a last attempt interrupted (recovery banner targets). */
export function listRecoveryTargetNodes(snapshot: WikiRunSnapshot): WikiRunNode[] {
  return snapshot.nodes.filter((node) => {
    if (node.state === "failed") return true;
    const attempt = lastAttemptForNode(snapshot, node);
    return attempt?.state === "interrupted";
  });
}

export function needsRecoveryBanner(snapshot: WikiRunSnapshot): boolean {
  if (snapshot.state === "failed") return true;
  return listRecoveryTargetNodes(snapshot).length > 0;
}
