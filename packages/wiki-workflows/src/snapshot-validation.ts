import type { WikiNode, WikiNodeActivity, WikiNodeAttempt, WikiNodeHistoryEntry, WikiNodeMetrics, WikiRunEvent, WikiRunSnapshot } from "./workflow-types.js";
import { wikiPolicyHash } from "./policy.js";
import { clone, isRecord } from "./util.js";
import { isCriticalGap } from "./run-nodes.js";

const SNAPSHOT_VERSION = 2 as const;

const NODE_KINDS = new Set(["inspect", "research", "synthesis", "write", "validate", "review", "finalize"]);
const NODE_STATUSES = new Set(["queued", "running", "succeeded", "failed", "invalidated", "cancelled", "blocked"]);
const RUN_STATUSES = new Set(["running", "paused", "succeeded", "failed", "blocked", "cancelled"]);
const ACTIVITY_STATES = new Set(["idle", "running", "compacting", "retrying", "waiting", "completed"]);
const HISTORY_KINDS = new Set(["message", "tool_call", "tool_result", "error"]);
const EVENT_KINDS = new Set([
  "run_started", "run_paused", "run_resumed", "run_cancelled", "run_completed", "run_failed", "run_blocked",
  "node_queued", "node_started", "node_activity", "node_succeeded", "node_failed", "node_invalidated",
  "node_cancelled", "node_retried", "phase_retried", "run_forked", "recovered",
]);

/** Reject corrupt persisted state before the workflow engine or UI can consume it. */
export function isWikiRunSnapshot(value: unknown): value is WikiRunSnapshot {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "version", "id", "cwd", "requestedMode", "effectiveMode", "language", "focus", "status", "round",
      "sourceRestartCount", "maxResearchRounds", "policy", "policyHash", "inspection", "inspectionSummary", "inspectionFingerprint",
      "nodes", "events", "createdAt", "updatedAt", "completedAt", "blockedReason", "blockedDetails", "parentRunId",
      "forkedFromNodeId", "forkedFromPhaseId", "forkedAt", "revision",
    ])
    || value.version !== SNAPSHOT_VERSION
    || !isString(value.id)
    || !isString(value.cwd)
    || !isMode(value.requestedMode)
    || !optional(value.effectiveMode, isMode)
    || (value.language !== "zh" && value.language !== "en")
    || !isEnum(value.status, RUN_STATUSES)
    || !isNonnegativeInteger(value.round)
    || !isNonnegativeInteger(value.sourceRestartCount)
    || !isResearchRoundLimit(value.maxResearchRounds)
    || !isPolicy(value.policy)
    || !isString(value.policyHash)
    || value.policyHash !== wikiPolicyHash(value.policy as WikiRunSnapshot["policy"])
    || !Array.isArray(value.nodes)
    || !value.nodes.every((node) => isNode(node, value.id as string))
    || !Array.isArray(value.events)
    || !value.events.every(isEvent)
    || !isString(value.createdAt)
    || !isString(value.updatedAt)
    || !optionalStringFields(value, [
      "focus", "inspectionFingerprint", "completedAt", "blockedReason", "parentRunId", "forkedFromNodeId",
      "forkedFromPhaseId", "forkedAt",
    ])
    || !optional(value.blockedDetails, isBlockedDetails)
    || !optional(value.revision, isNonnegativeInteger)
    || value.inspection !== undefined
    || !optional(value.inspectionSummary, isInspectionSummary)) return false;

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
  }
  if (value.nodes.some((node) => node.dependsOn.some((dependency) => !nodeIds.has(dependency)))) return false;
  return isAcyclic(value.nodes);
}

/**
 * Human-readable validation failures for a candidate snapshot.
 * Empty array means the value is a valid WikiRunSnapshot.
 */
export function explainWikiRunSnapshot(value: unknown): string[] {
  if (!isRecord(value)) return ["expected an object"];

  const reasons: string[] = [];
  if (value.version !== SNAPSHOT_VERSION) {
    reasons.push(`version: expected ${SNAPSHOT_VERSION}, got ${formatGot(value.version)}`);
  }
  if (!isString(value.id)) reasons.push(`id: expected string, got ${formatGot(value.id)}`);
  if (!isString(value.cwd)) reasons.push(`cwd: expected string, got ${formatGot(value.cwd)}`);
  if (!isMode(value.requestedMode)) {
    reasons.push(`requestedMode: expected "generate" | "refresh", got ${formatGot(value.requestedMode)}`);
  }
  if (value.effectiveMode !== undefined && !isMode(value.effectiveMode)) {
    reasons.push(`effectiveMode: expected "generate" | "refresh", got ${formatGot(value.effectiveMode)}`);
  }
  if (value.language !== "zh" && value.language !== "en") {
    reasons.push(`language: expected "zh" | "en", got ${formatGot(value.language)}`);
  }
  if (!isEnum(value.status, RUN_STATUSES)) {
    reasons.push(`status: expected one of ${[...RUN_STATUSES].join("|")}, got ${formatGot(value.status)}`);
  }
  if (!isNonnegativeInteger(value.round)) {
    reasons.push(`round: expected nonnegative integer, got ${formatGot(value.round)}`);
  }
  if (!isNonnegativeInteger(value.sourceRestartCount)) {
    reasons.push(`sourceRestartCount: expected nonnegative integer, got ${formatGot(value.sourceRestartCount)}`);
  }
  if (!isResearchRoundLimit(value.maxResearchRounds)) {
    reasons.push(`maxResearchRounds: expected integer 3..20, got ${formatGot(value.maxResearchRounds)}`);
  }
  if (!isPolicy(value.policy)) reasons.push("policy: invalid pinned Wiki policy");
  if (!isString(value.policyHash)) reasons.push(`policyHash: expected string, got ${formatGot(value.policyHash)}`);
  else if (isPolicy(value.policy) && value.policyHash !== wikiPolicyHash(value.policy as WikiRunSnapshot["policy"])) {
    reasons.push("policyHash: does not match pinned Wiki policy");
  }
  if (!Array.isArray(value.nodes)) reasons.push(`nodes: expected array, got ${formatGot(value.nodes)}`);
  else if (!value.nodes.every((node) => isNode(node, isString(value.id) ? value.id : ""))) reasons.push("nodes: contains invalid node entries");
  if (!Array.isArray(value.events)) reasons.push(`events: expected array, got ${formatGot(value.events)}`);
  else if (!value.events.every(isEvent)) reasons.push("events: contains invalid event entries");
  if (!isString(value.createdAt)) reasons.push(`createdAt: expected string, got ${formatGot(value.createdAt)}`);
  if (!isString(value.updatedAt)) reasons.push(`updatedAt: expected string, got ${formatGot(value.updatedAt)}`);
  if (value.revision !== undefined && !isNonnegativeInteger(value.revision)) {
    reasons.push(`revision: expected nonnegative integer, got ${formatGot(value.revision)}`);
  }
  if (value.inspection !== undefined) {
    reasons.push("inspection: full runtime payload is not allowed in a durable snapshot");
  }
  if (value.inspectionSummary !== undefined && !isInspectionSummary(value.inspectionSummary)) {
    reasons.push("inspectionSummary: invalid inspection summary");
  }

  if (reasons.length > 0) return reasons;
  if (!isWikiRunSnapshot(value)) {
    return ["snapshot failed structural validation (duplicate node ids, missing dependencies, or graph cycle)"];
  }
  return [];
}

function isPolicy(value: unknown): boolean {
  if (!isRecord(value)
    || value.version !== 1
    || !isStringArray(value.exclude)
    || !value.exclude.every((item) => item.length > 0 && item.trim() === item)
    || !isRecord(value.terminology)
    || !Object.entries(value.terminology).every(([term, definition]) => term.length > 0 && term.trim() === term
      && isString(definition) && definition.length > 0 && definition.trim() === definition)
    || !Array.isArray(value.domains)
    || !value.domains.every((domain) => isRecord(domain)
      && isString(domain.id) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(domain.id)
      && isString(domain.title) && domain.title.length > 0 && domain.title.trim() === domain.title
      && isStringArray(domain.include) && domain.include.length > 0 && domain.include.every((item) => item.length > 0 && item.trim() === item)
      && isStringArray(domain.exclude) && domain.exclude.every((item) => item.length > 0 && item.trim() === item))
    || !isRecord(value.quality)
    || !boundedInteger(value.quality.maxSubmissionAttempts, 1, 3)
    || !isRecord(value.runtime)
    || !boundedInteger(value.runtime.maxConcurrentAgents, 1, 4)
    || !boundedInteger(value.runtime.nodeTimeoutSeconds, 60, 1_800)
    || !boundedInteger(value.runtime.maxAutoRetries, 1, 16)
    || !boundedInteger(value.runtime.maxTransientSessionAttempts, 1, 2)
    || !boundedInteger(value.runtime.rateLimitCooldownSeconds, 15, 120)
    || !isString(value.promptBundleHash) || !/^[a-f0-9]{64}$/.test(value.promptBundleHash)) return false;
  return new Set(value.domains.map((domain) => (domain as { id: string }).id)).size === value.domains.length;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

/**
 * Parse and clone a snapshot, or throw an Error with `code: "snapshot_incompatible"`.
 */
export function parseWikiRunSnapshot(value: unknown): WikiRunSnapshot {
  if (isWikiRunSnapshot(value)) return clone(value);
  const reasons = explainWikiRunSnapshot(value);
  const detail = reasons.length > 0 ? reasons.join("; ") : "unknown validation failure";
  const error = new Error(`Wiki run snapshot is incompatible: ${detail}`) as Error & { code: "snapshot_incompatible" };
  error.name = "WikiSnapshotIncompatibleError";
  error.code = "snapshot_incompatible";
  throw error;
}

function formatGot(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function isNode(value: unknown, runId: string): value is WikiNode {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "id", "kind", "label", "phaseId", "phaseTitle", "status", "dependsOn", "attempt", "inputFingerprint", "input",
      "result", "output", "history", "handoff", "error", "attemptHistory", "metrics", "activity", "startedAt", "finishedAt",
    ])
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
    || !optional(value.result, (result) => isNodeReceipt(runId, value.id as string, value.attempt as number, value.kind as WikiNode["kind"], result, value.handoff))
    || !optional(value.history, isHistory)
    || !optional(value.error, isError)
    || !optional(value.handoff, isArtifactRef)) return false;
  if (value.status === "succeeded" && (!value.handoff || value.result === undefined)) return false;
  return true;
}

function isNodeReceipt(runId: string, nodeId: string, attempt: number, kind: WikiNode["kind"], value: unknown, handoff: unknown): boolean {
  if (!isRecord(value) || !isRecord(handoff) || !isArtifactRef(handoff)) return false;
  const artifact = value.artifact;
  const expectedKind = artifactKindForNode(kind);
  if (!expectedKind || !isRecord(artifact) || !isArtifactRef(artifact)
    || JSON.stringify(artifact) !== JSON.stringify(handoff)
    || artifact.runId !== runId || artifact.nodeId !== nodeId || artifact.attempt !== attempt || artifact.kind !== expectedKind) return false;
  if (kind === "research") {
    return exactKeys(value, ["scopeId", "task", "sourceFingerprint", "artifact", "findings", "criticalGaps"])
      && isString(value.scopeId) && isString(value.task) && isString(value.sourceFingerprint)
      && Array.isArray(value.findings) && value.findings.every((item) => isRecord(item) && isString(item.id)
        && (item.priority === "critical" || item.priority === "normal"))
      && Array.isArray(value.criticalGaps) && value.criticalGaps.every(isCriticalGap);
  }
  if (kind === "inspect") return exactKeys(value, ["kind", "artifact", "mode", "head", "sourceFingerprint", "sourceCount", "changedPathCount", "existingPageCount", "impactedPageCount"])
    && value.kind === "inspection" && value.mode !== undefined
    && (value.mode === "generate" || value.mode === "refresh") && isString(value.head) && isString(value.sourceFingerprint)
    && receiptCounts(value, ["sourceCount", "changedPathCount", "existingPageCount", "impactedPageCount"]);
  if (kind === "synthesis") return exactKeys(value, ["kind", "artifact", "domainCount", "pageCount"])
    && value.kind === "synthesis"
    && receiptCounts(value, ["domainCount", "pageCount"]);
  if (kind === "write") return exactKeys(value, ["kind", "artifact", "page", "sha256"]) && value.kind === "write" && isString(value.page) && isString(value.sha256);
  if (kind === "validate") return exactKeys(value, ["kind", "artifact", "ok", "issueCount", "pageCount", "obsoletePageCount"])
    && value.kind === "validation" && isBoolean(value.ok)
    && receiptCounts(value, ["issueCount", "pageCount", "obsoletePageCount"]);
  if (kind === "review") return exactKeys(value, ["kind", "artifact", "defectCount", "summary"])
    && value.kind === "review" && isString(value.summary)
    && receiptCounts(value, ["defectCount"]);
  if (kind === "finalize") return exactKeys(value, value.sourceDrift === true
    ? ["kind", "artifact", "sourceDrift"]
    : ["kind", "artifact", "sourceDrift", "pageCount", "obsoletePageCount", "removedPageCount", "rebuiltIndexCount"])
    && value.kind === "finalization" && isBoolean(value.sourceDrift)
    && receiptCounts(value, ["pageCount", "obsoletePageCount", "removedPageCount", "rebuiltIndexCount"], true);
  return false;
}

function artifactKindForNode(kind: WikiNode["kind"]): string | undefined {
  return ({ inspect: "inspection", research: "research", synthesis: "synthesis", write: "write_report", validate: "validation", review: "review", finalize: "finalization" } as const)[kind];
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function receiptCounts(value: Record<string, unknown>, keys: string[], optional = false): boolean {
  return keys.every((key) => optional ? value[key] === undefined || isNonnegativeInteger(value[key]) : isNonnegativeInteger(value[key]));
}

function isAttempt(value: unknown): value is WikiNodeAttempt {
  return isRecord(value)
    && hasOnlyKeys(value, ["attempt", "startedAt", "finishedAt", "output", "history", "handoff", "error", "metrics"])
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
  const optionalNumbers = ["contextTokens", "contextWindow", "contextPercent", "salvageAttempts", "correctionAttempts"];
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
    && hasOnlyKeys(value, ["message", "code", "retryable", "requiredSubmissionTools"])
    && isString(value.message)
    && optionalStringFields(value, ["code"])
    && optional(value.retryable, isBoolean)
    && optional(value.requiredSubmissionTools, (items) => Array.isArray(items) && items.length > 0 && items.every((item) => item === "wiki_submit_research"
      || item === "wiki_submit_synthesis_finalize"
      || item === "wiki_submit_page" || item === "wiki_submit_review"));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
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

function isBlockedDetails(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.code !== undefined && typeof value.code !== "string") return false;
  if (value.page !== undefined && typeof value.page !== "string") return false;
  if (value.comparedNodeId !== undefined && typeof value.comparedNodeId !== "string") return false;
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues)) return false;
    if (!value.issues.every((issue) => isRecord(issue)
      && isString(issue.code)
      && isString(issue.message)
      && optional(issue.page, isString))) return false;
  }
  if (value.defects !== undefined) {
    if (!Array.isArray(value.defects)) return false;
    if (!value.defects.every((defect) => isRecord(defect)
      && Object.values(defect).every((entry) => typeof entry === "string"))) return false;
  }
  if (value.remainingBudget !== undefined) {
    if (!isRecord(value.remainingBudget)) return false;
    if (!Object.values(value.remainingBudget).every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      return false;
    }
  }
  if (value.criticalGaps !== undefined
    && (!Array.isArray(value.criticalGaps) || !value.criticalGaps.every(isCriticalGap))) return false;
  return true;
}

function isInspectionSummary(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ["kind", "mode", "head", "sourceFingerprint", "sourceCount", "changedPathCount", "existingPageCount", "impactedPageCount"])
    && value.kind === "inspection_summary"
    && isMode(value.mode)
    && isString(value.head)
    && isString(value.sourceFingerprint)
    && receiptCounts(value, ["sourceCount", "changedPathCount", "existingPageCount", "impactedPageCount"]);
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

function isResearchRoundLimit(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 3 && Number(value) <= 20;
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
