import type { WikiNode, WikiNodeActivity, WikiNodeAttempt, WikiNodeHistoryEntry, WikiNodeMetrics, WikiRunEvent, WikiRunSnapshot } from "./workflow-types.js";

const NODE_KINDS = new Set(["inspect", "research", "synthesis", "write", "validate", "review", "finalize"]);
const NODE_STATUSES = new Set(["queued", "running", "succeeded", "failed", "invalidated", "cancelled", "blocked"]);
const RUN_STATUSES = new Set(["running", "paused", "succeeded", "failed", "blocked", "cancelled"]);
const ACTIVITY_STATES = new Set(["idle", "running", "compacting", "retrying", "waiting", "completed"]);
const HISTORY_KINDS = new Set(["message", "tool_call", "tool_result", "error"]);
const EVENT_KINDS = new Set([
  "run_started", "run_paused", "run_resumed", "run_cancelled", "run_completed", "run_blocked",
  "node_queued", "node_started", "node_activity", "node_succeeded", "node_failed", "node_invalidated",
  "node_cancelled", "node_retried", "phase_retried", "run_forked", "recovered",
]);

/** Reject corrupt persisted state before the workflow engine or UI can consume it. */
export function isWikiRunSnapshot(value: unknown): value is WikiRunSnapshot {
  if (!isRecord(value)
    || value.version !== 5
    || !isString(value.id)
    || !isString(value.cwd)
    || !isMode(value.requestedMode)
    || !optional(value.effectiveMode, isMode)
    || (value.language !== "zh" && value.language !== "en")
    || !isEnum(value.status, RUN_STATUSES)
    || !isNonnegativeInteger(value.round)
    || !isNonnegativeInteger(value.sourceRestartCount)
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isNode)
    || !Array.isArray(value.events)
    || !value.events.every(isEvent)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || !optionalStringFields(value, [
      "focus", "inspectionFingerprint", "completedAt", "blockedReason", "parentRunId", "forkedFromNodeId",
      "forkedFromPhaseId", "forkedAt",
    ])
    || !optional(value.inspection, isInspection)) return false;

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
  }
  if (value.nodes.some((node) => node.dependsOn.some((dependency) => !nodeIds.has(dependency)))) return false;
  return isAcyclic(value.nodes);
}

function isNode(value: unknown): value is WikiNode {
  if (!isRecord(value)
    || !isString(value.id)
    || !isEnum(value.kind, NODE_KINDS)
    || !isString(value.label)
    || !optionalStringFields(value, ["phaseId", "phaseTitle", "output", "startedAt", "finishedAt"])
    || !isEnum(value.status, NODE_STATUSES)
    || !isStringArray(value.dependsOn)
    || !isNonnegativeInteger(value.attempt)
    || !isString(value.inputFingerprint)
    || !("input" in value)
    || !Array.isArray(value.attemptHistory)
    || !value.attemptHistory.every(isAttempt)
    || !isMetrics(value.metrics)
    || !isActivity(value.activity)
    || !optional(value.history, isHistory)
    || !optional(value.error, isError)
    || !optional(value.handoff, isArtifactRef)) return false;
  return true;
}

function isAttempt(value: unknown): value is WikiNodeAttempt {
  return isRecord(value)
    && isNonnegativeInteger(value.attempt)
    && optionalStringFields(value, ["startedAt", "finishedAt", "output"])
    && optional(value.history, isHistory)
    && optional(value.error, isError)
    && optional(value.handoff, isArtifactRef)
    && isMetrics(value.metrics);
}

function isMetrics(value: unknown): value is WikiNodeMetrics {
  if (!isRecord(value)) return false;
  const required = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "cost", "compactions", "autoRetries"];
  const optionalNumbers = ["contextTokens", "contextWindow", "contextPercent"];
  return required.every((key) => isNonnegativeNumber(value[key]))
    && optionalNumbers.every((key) => optional(value[key], isNonnegativeNumber))
    && optional(value.model, isString)
    && optional(value.contextEstimated, isBoolean);
}

function isActivity(value: unknown): value is WikiNodeActivity {
  return isRecord(value)
    && isEnum(value.state, ACTIVITY_STATES)
    && isString(value.updatedAt)
    && optional(value.message, isString)
    && optional(value.retryAttempt, isNonnegativeInteger)
    && optional(value.retryMaxAttempts, isNonnegativeInteger)
    && optional(value.retryDelayMs, isNonnegativeNumber);
}

function isHistory(value: unknown): value is WikiNodeHistoryEntry[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry)
    && isString(entry.at)
    && isEnum(entry.kind, HISTORY_KINDS)
    && isString(entry.text)
    && optionalStringFields(entry, ["toolName", "toolCallId", "target", "summary"])
    && optional(entry.isError, isBoolean));
}

function isError(value: unknown): boolean {
  return isRecord(value)
    && isString(value.message)
    && optionalStringFields(value, ["code"])
    && optional(value.retryable, isBoolean)
    && optional(value.requiredSubmissionTool, (item) => item === "wiki_submit_synthesis" || item === "wiki_submit_review");
}

function isArtifactRef(value: unknown): boolean {
  return isRecord(value)
    && value.version === 1
    && isString(value.runId)
    && isString(value.nodeId)
    && isNonnegativeInteger(value.attempt)
    && isString(value.kind)
    && isString(value.relativePath)
    && typeof value.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.sha256)
    && isNonnegativeInteger(value.sizeBytes)
    && isString(value.mediaType);
}

function isEvent(value: unknown): value is WikiRunEvent {
  return isRecord(value)
    && isString(value.id)
    && isString(value.at)
    && isEnum(value.kind, EVENT_KINDS)
    && optionalStringFields(value, ["nodeId", "message"])
    && optional(value.data, isRecord);
}

function isInspection(value: unknown): boolean {
  return isRecord(value)
    && isString(value.root)
    && isString(value.wikiRoot)
    && isStringArray(value.sourcePaths)
    && isMode(value.mode)
    && isString(value.head)
    && (value.baseCommit === null || isString(value.baseCommit))
    && (value.lastWikiCommit === null || isString(value.lastWikiCommit))
    && Array.isArray(value.changed)
    && value.changed.every((change) => isRecord(change) && isString(change.status) && isStringArray(change.paths))
    && isStringArray(value.changedPaths)
    && isString(value.sourceFingerprint)
    && isStringArray(value.existingPages)
    && isStringArray(value.impactedPages)
    && isBoolean(value.wikiDrift);
}

function isAcyclic(nodes: WikiNode[]): boolean {
  const dependencies = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return nodes.every((node) => visit(node.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMode(value: unknown): boolean {
  return value === "generate" || value === "refresh";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isEnum(value: unknown, allowed: Set<string>): value is string {
  return typeof value === "string" && allowed.has(value);
}

function optional<T>(value: unknown, predicate: (item: unknown) => item is T): value is T | undefined;
function optional(value: unknown, predicate: (item: unknown) => boolean): boolean;
function optional(value: unknown, predicate: (item: unknown) => boolean): boolean {
  return value === undefined || predicate(value);
}

function optionalStringFields(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => optional(value[key], isString));
}
