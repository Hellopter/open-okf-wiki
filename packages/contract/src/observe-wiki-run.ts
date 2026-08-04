/**
 * Pure observation helpers for WikiRuns snapshots.
 * No I/O — shared by operator UI and host projections.
 */

import { allNodeContracts } from "./node-contract.js";
import type {
  WikiRunAttempt,
  WikiRunGate,
  WikiRunNodeKind,
  WikiRunSnapshot,
} from "./wiki-runs.js";

/** Stage buckets for operator-facing topology / progress grouping. */
export type WikiRunObservationStage =
  | "plan"
  | "research"
  | "write"
  | "review"
  | "repair"
  | "validate"
  | "publish"
  | "gate"
  | "other";

/** How a node kind is executed (from NodeContract when registered). */
export type WikiRunExecutionClass = "pi" | "mechanical" | "gate" | "other";

/**
 * Map a durable (or display) node kind to an observation stage bucket.
 * More granular than web WorkflowStageId; gates are their own bucket.
 */
export function stageForNodeKind(kind: WikiRunNodeKind): WikiRunObservationStage {
  switch (kind) {
    case "freeze":
    case "plan":
    case "plan.scout":
      return "plan";
    case "plan.adapt":
    case "research.leaf":
    case "research.domain":
      return "research";
    case "write.root":
      return "write";
    case "review.seat":
    case "review.reduce":
      return "review";
    case "repair":
      return "repair";
    case "validate.pre":
    case "validate.final":
      return "validate";
    case "prepare.publication":
    case "publish":
      return "publish";
    case "gate.plan":
    case "gate.fix":
    case "gate.publication":
      return "gate";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return "other";
    }
  }
}

/**
 * Execution class for a node kind via the fixed NodeContract registry.
 * Unregistered kinds return `"other"`.
 */
export function executionClassForNodeKind(kind: WikiRunNodeKind): WikiRunExecutionClass {
  const contract = allNodeContracts().find((entry) => entry.kind === kind);
  if (!contract) return "other";
  return contract.execution;
}

/**
 * Latest attempt for a node key: highest nodeGeneration, then runIndex, then startedAt.
 */
export function latestAttemptForNode(
  attempts: readonly WikiRunAttempt[],
  nodeKey: string,
): WikiRunAttempt | undefined {
  let latest: WikiRunAttempt | undefined;
  for (const attempt of attempts) {
    if (attempt.nodeKey !== nodeKey) continue;
    if (!latest) {
      latest = attempt;
      continue;
    }
    if (attempt.nodeGeneration !== latest.nodeGeneration) {
      if (attempt.nodeGeneration > latest.nodeGeneration) latest = attempt;
      continue;
    }
    if (attempt.runIndex !== latest.runIndex) {
      if (attempt.runIndex > latest.runIndex) latest = attempt;
      continue;
    }
    if (attempt.startedAt > latest.startedAt) latest = attempt;
  }
  return latest;
}

/** Gates currently open on a snapshot (operator HITL pending). */
export function openGates(snapshot: WikiRunSnapshot): WikiRunGate[] {
  return snapshot.gates.filter((gate) => gate.state === "open");
}
