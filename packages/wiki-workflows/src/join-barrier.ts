import { isRecord } from "./util.js";

export type JoinGroupKind = "research" | "write" | "verify";

export interface JoinMember {
  id: string;
  /** Prefer WikiNodeStatus at call sites. */
  status: string;
}

const TERMINAL_FAILURE_STATUSES = new Set<string>(["failed", "blocked", "cancelled"]);

/** Returns true only when every member has status === "succeeded". */
export function groupAllSucceeded(members: readonly JoinMember[]): boolean {
  return members.length > 0 && members.every((member) => member.status === "succeeded");
}

/** Returns true if any member is failed/blocked/cancelled (join cannot complete successfully). */
export function groupHasTerminalFailure(members: readonly JoinMember[]): boolean {
  return members.some((member) => TERMINAL_FAILURE_STATUSES.has(member.status));
}

/**
 * Given sibling members of a join group, decide join readiness.
 * Target engine path: mark status=succeeded first, then tryJoin once via evaluateJoin.
 */
export function evaluateJoin(
  members: readonly JoinMember[],
): { ready: boolean; reason: "not_ready" | "all_succeeded" | "terminal_failure" } {
  if (groupHasTerminalFailure(members)) {
    return { ready: false, reason: "terminal_failure" };
  }
  if (groupAllSucceeded(members)) {
    return { ready: true, reason: "all_succeeded" };
  }
  return { ready: false, reason: "not_ready" };
}

/**
 * Find sibling nodes that share a group key field on input.
 * groupField examples: researchGroupId, writeGroupId, verificationGroupId
 *
 * Invalidated nodes are graph-dead (source-drift restart, fork-and-retry) and
 * must not participate in join. Deterministic group ids are reused across
 * restart waves, so including invalidated siblings would stall the join forever.
 */
export function siblingsByGroupKey(
  nodes: readonly { id: string; kind: string; status: string; input: unknown }[],
  kind: string | string[],
  groupField: string,
  groupId: string,
): JoinMember[] {
  const kinds = new Set(Array.isArray(kind) ? kind : [kind]);
  return nodes
    .filter((node) =>
      kinds.has(node.kind)
      && node.status !== "invalidated"
      && inputFieldEquals(node.input, groupField, groupId))
    .map((node) => ({ id: node.id, status: node.status }));
}

function inputFieldEquals(input: unknown, field: string, expected: string): boolean {
  if (!isRecord(input)) return false;
  return input[field] === expected;
}
