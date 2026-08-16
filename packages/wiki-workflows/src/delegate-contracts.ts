import type { WikiArtifactRef } from "./artifact-store.js";
import { createHash } from "node:crypto";
import type { WikiBudgetExhaustedCode } from "./failures.js";
import { isSafeWikiPagePath } from "./lead.js";
import { sameStringSet, stableStringify } from "./util.js";
import type { WikiAgentOutcome } from "./producer-types.js";

export interface WikiReviewFinding {
  path: string;
  severity: "critical" | "major" | "minor";
  message: string;
  evidence: string[];
  suggestion: string;
}

export interface WikiReviewResult {
  verdict: "pass" | "changes_requested";
  reviewedPaths: string[];
  findings: WikiReviewFinding[];
  profileCoverage: string[];
}

export function parseWikiReviewResult(value: unknown): WikiReviewResult {
  const review = record(value, "Wiki review result");
  exactKeys(review, ["verdict", "reviewedPaths", "findings", "profileCoverage"], "Wiki review result");
  if (review.verdict !== "pass" && review.verdict !== "changes_requested") throw new Error("Invalid Wiki review verdict");
  const reviewedPaths = strings(review.reviewedPaths, "Wiki review reviewedPaths");
  if (!Array.isArray(review.findings)) throw new Error("Invalid review result findings");
  const findings: WikiReviewFinding[] = review.findings.map((value) => {
    const finding = record(value, "Wiki review finding");
    exactKeys(finding, ["path", "severity", "message", "evidence", "suggestion"], "Wiki review finding");
    if (finding.severity !== "critical" && finding.severity !== "major" && finding.severity !== "minor") throw new Error("Invalid Wiki review finding severity");
    return {
      severity: finding.severity,
      path: nonEmpty(finding.path, "Wiki review finding path"),
      message: nonEmpty(finding.message, "Wiki review finding message"),
      evidence: strings(finding.evidence, "Wiki review finding evidence"),
      suggestion: nonEmpty(finding.suggestion, "Wiki review finding suggestion"),
    };
  });
  const profileCoverage = strings(review.profileCoverage, "Wiki review profileCoverage");
  if (reviewedPaths.some((page) => !safeAssignedWikiPath(page)) || new Set(reviewedPaths).size !== reviewedPaths.length) throw new Error("Invalid Wiki review reviewedPaths");
  if (findings.some((finding) => !reviewedPaths.includes(finding.path))) throw new Error("Wiki review finding path is outside reviewedPaths");
  return { verdict: review.verdict, reviewedPaths, findings, profileCoverage };
}

export type WikiDelegateRole = "research" | "write" | "review";

interface WikiDelegateTaskBase {
  id: string;
  instruction: string;
  sourceScopeIds: string[];
  contextRefs: string[];
}

export type WikiDelegateTask =
  | WikiDelegateTaskBase & { role: "research"; writePaths?: never; reviewPaths?: never }
  | WikiDelegateTaskBase & { role: "write"; writePaths: string[]; reviewPaths?: never }
  | WikiDelegateTaskBase & { role: "review"; reviewPaths: string[]; writePaths?: never };

export interface WikiReviewBasis {
  version: 1;
  candidateRevision: number;
  treeDigest: string;
  policyDigest: string;
  paths: string[];
}

export type WikiDelegateContract = WikiDelegateTask & {
  contractVersion: 1;
  contractId: string;
  contractDigest: string;
  batchId: number;
  reviewBasis?: WikiReviewBasis;
};

/** The only constructor for durable delegate contracts. */
export function createWikiDelegateContract(
  batchId: number,
  value: unknown,
  reviewBasis?: WikiReviewBasis,
): WikiDelegateContract {
  const task = parseWikiDelegateTask(value);
  if (!Number.isSafeInteger(batchId) || batchId < 1) throw new Error("Invalid Wiki delegate contract batch");
  const basis = reviewBasis === undefined ? undefined : parseWikiReviewBasis(reviewBasis);
  if ((task.role === "review") !== Boolean(basis)) throw new Error("Only review delegate contracts require a review basis");
  if (basis && !sameStringSet(basis.paths, task.reviewPaths ?? [])) {
    throw new Error("Wiki review basis paths must exactly match the assigned review paths");
  }
  const body = {
    ...task,
    contractVersion: 1 as const,
    contractId: `b${batchId}-${task.id}`,
    batchId,
    ...(basis ? { reviewBasis: basis } : {}),
  };
  return parseWikiDelegateContract({ ...body, contractDigest: hashContract(body) });
}

export type WikiDelegateStatus = "complete" | "incomplete" | "failed";

export interface WikiDelegateGap {
  question: string;
  sourceScopeIds?: string[];
}

export interface WikiDelegateError {
  code: WikiTaskFailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface WikiDelegateReceipt {
  id: string;
  role: WikiDelegateRole;
  status: WikiDelegateStatus;
  summary: string;
  outputs: WikiArtifactRef[];
  coverage: string[];
  gaps: WikiDelegateGap[];
  error?: WikiDelegateError;
  attempts: number;
  review?: WikiReviewResult;
  contractId: string;
  contractDigest: string;
}

export interface WikiDelegateBatchSnapshot {
  batchId: number;
  status: "running" | "complete" | "partial" | "failed";
  receipts: WikiDelegateReceipt[];
  pendingTaskIds: string[];
}

export type WikiTaskFailureCode =
  | "rate_limit"
  | "quota"
  | "usage_limit"
  | "server_error"
  | "network_reset"
  | "timeout"
  | "context_exhausted"
  | "unauthorized"
  | "forbidden"
  | "billing"
  | "invalid_request"
  | "schema"
  | "artifact_io"
  | "cancelled"
  | "unknown"
  | WikiBudgetExhaustedCode;

export class WikiTaskExecutionError extends Error {
  constructor(
    message: string,
    readonly code?: WikiTaskFailureCode,
    readonly options: {
      retryAfterMs?: number;
      partialMarkdown?: string;
      coverage?: string[];
      gaps?: WikiDelegateGap[];
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WikiTaskExecutionError";
  }
}

/** Internal control signal: provider pauses never become model-visible tool results. */
export class WikiTaskPauseError extends Error {
  constructor(
    readonly reason: "quota" | "usage_limit",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "WikiTaskPauseError";
  }
}

export function boundedDelegateSummary(value: string): string {
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") <= 1024) return text;
  let result = text;
  while (result && Buffer.byteLength(`${result}...`, "utf8") > 1024) result = result.slice(0, -1);
  return `${result}...`;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FAILURE_CODES = new Set<WikiTaskFailureCode>([
  "rate_limit", "quota", "usage_limit", "server_error", "network_reset", "timeout", "context_exhausted",
  "unauthorized", "forbidden", "billing", "invalid_request", "schema", "artifact_io", "cancelled", "unknown",
  "delegated_tasks_exhausted", "delegate_batches_exhausted", "session_turns_exhausted",
  "session_tool_calls_exhausted",
]);

export function parseWikiDelegateTask(value: unknown): WikiDelegateTask {
  const raw = record(value, "Wiki delegate task");
  exactKeys(raw, ["id", "role", "instruction", "sourceScopeIds", "contextRefs", "writePaths", "reviewPaths"], "Wiki delegate task");
  const id = safeId(raw.id, "Wiki delegate task id");
  const instruction = nonEmpty(raw.instruction, "Wiki delegate instruction");
  const sourceScopeIds = strings(raw.sourceScopeIds, "Wiki delegate sourceScopeIds");
  const contextRefs = strings(raw.contextRefs, "Wiki delegate contextRefs");
  if (new Set(sourceScopeIds).size !== sourceScopeIds.length || new Set(contextRefs).size !== contextRefs.length) throw new Error("Wiki delegate scopes and context refs must be unique");
  if (raw.role === "research") {
    if (raw.writePaths !== undefined || raw.reviewPaths !== undefined) throw new Error("Research delegate cannot declare writePaths or reviewPaths");
    return { id, role: "research", instruction, sourceScopeIds, contextRefs };
  }
  if (raw.role === "write") {
    if (raw.reviewPaths !== undefined) throw new Error("Write delegate cannot declare reviewPaths");
    const writePaths = nonEmptyStrings(raw.writePaths, "Wiki writePaths");
    assertAssignedWikiPaths(writePaths, "writePaths");
    return { id, role: "write", instruction, sourceScopeIds, contextRefs, writePaths };
  }
  if (raw.role === "review") {
    if (raw.writePaths !== undefined) throw new Error("Review delegate cannot declare writePaths");
    const reviewPaths = nonEmptyStrings(raw.reviewPaths, "Wiki reviewPaths");
    assertAssignedWikiPaths(reviewPaths, "reviewPaths");
    return { id, role: "review", instruction, sourceScopeIds, contextRefs, reviewPaths };
  }
  throw new Error("Invalid Wiki delegate role");
}

export function parseWikiReviewBasis(value: unknown): WikiReviewBasis {
  const raw = record(value, "Wiki review basis");
  exactKeys(raw, ["version", "candidateRevision", "treeDigest", "policyDigest", "paths"], "Wiki review basis");
  if (raw.version !== 1 || !Number.isSafeInteger(raw.candidateRevision) || (raw.candidateRevision as number) < 0) throw new Error("Invalid Wiki review basis revision");
  const paths = nonEmptyStrings(raw.paths, "Wiki review paths");
  assertAssignedWikiPaths(paths, "review paths");
  return {
    version: 1,
    candidateRevision: raw.candidateRevision as number,
    treeDigest: digest(raw.treeDigest, "Wiki review tree digest"),
    policyDigest: digest(raw.policyDigest, "Wiki review policy digest"),
    paths,
  };
}

export function parseWikiDelegateContract(value: unknown): WikiDelegateContract {
  const raw = record(value, "Wiki delegate contract");
  exactKeys(raw, ["id", "role", "instruction", "sourceScopeIds", "contextRefs", "writePaths", "reviewPaths", "contractVersion", "contractId", "contractDigest", "batchId", "reviewBasis"], "Wiki delegate contract");
  const task = parseWikiDelegateTask(Object.fromEntries(Object.entries(raw).filter(([key]) => !["contractVersion", "contractId", "contractDigest", "batchId", "reviewBasis"].includes(key))));
  if (raw.contractVersion !== 1 || !Number.isSafeInteger(raw.batchId) || (raw.batchId as number) < 1) throw new Error("Invalid Wiki delegate contract version or batch");
  const basis = raw.reviewBasis === undefined ? undefined : parseWikiReviewBasis(raw.reviewBasis);
  if ((task.role === "review") !== Boolean(basis)) throw new Error("Only review delegate contracts require a review basis");
  if (basis && !sameStringSet(basis.paths, task.reviewPaths ?? [])) throw new Error("Wiki review basis paths must exactly match the assigned review paths");
  const contract: WikiDelegateContract = {
    ...task,
    contractVersion: 1,
    contractId: safeId(raw.contractId, "Wiki delegate contract id"),
    contractDigest: digest(raw.contractDigest, "Wiki delegate contract digest"),
    batchId: raw.batchId as number,
    ...(basis ? { reviewBasis: basis } : {}),
  };
  if (contract.contractId !== `b${contract.batchId}-${contract.id}`) throw new Error("Wiki delegate contract identity does not match batch/task");
  const { contractDigest, ...body } = contract;
  if (hashContract(body) !== contractDigest) throw new Error("Wiki delegate contract digest mismatch");
  return contract;
}

export function parseWikiDelegateError(value: unknown): WikiDelegateError {
  const raw = record(value, "Wiki delegate error");
  exactKeys(raw, ["code", "message", "retryable", "retryAfterMs"], "Wiki delegate error");
  if (!FAILURE_CODES.has(raw.code as WikiTaskFailureCode) || typeof raw.retryable !== "boolean") throw new Error("Invalid Wiki delegate error");
  const retryAfterMs = raw.retryAfterMs;
  if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || (retryAfterMs as number) < 0)) throw new Error("Invalid Wiki delegate retryAfterMs");
  return { code: raw.code as WikiTaskFailureCode, message: nonEmpty(raw.message, "Wiki delegate error message"), retryable: raw.retryable, ...(retryAfterMs !== undefined ? { retryAfterMs: retryAfterMs as number } : {}) };
}

export function parseWikiDelegateReceipt(value: unknown): WikiDelegateReceipt {
  const raw = record(value, "Wiki delegate receipt");
  exactKeys(raw, ["id", "role", "status", "summary", "outputs", "coverage", "gaps", "error", "attempts", "review", "contractId", "contractDigest"], "Wiki delegate receipt");
  const id = safeId(raw.id, "Wiki delegate receipt id");
  if (!["research", "write", "review"].includes(String(raw.role)) || !["complete", "incomplete", "failed"].includes(String(raw.status))
    || !Number.isSafeInteger(raw.attempts) || (raw.attempts as number) < 1 || !Array.isArray(raw.outputs) || !Array.isArray(raw.gaps)) {
    throw new Error("Invalid Wiki delegate receipt");
  }
  const role = raw.role as WikiDelegateRole;
  const review = raw.review === undefined ? undefined : parseWikiReviewResult(raw.review);
  if ((review !== undefined) !== (role === "review" && raw.status === "complete")) throw new Error("Only complete review receipts may contain a review result");
  const error = raw.error === undefined ? undefined : parseWikiDelegateError(raw.error);
  if (raw.status === "complete" && error || raw.status === "failed" && !error) throw new Error("Invalid Wiki delegate receipt error/status combination");
  const contractId = safeId(raw.contractId, "Wiki delegate receipt contract id");
  const contractDigest = digest(raw.contractDigest, "Wiki delegate receipt contract digest");
  return {
    id,
    role,
    status: raw.status as WikiDelegateStatus,
    summary: nonEmpty(raw.summary, "Wiki delegate receipt summary"),
    outputs: raw.outputs.map(parseWikiArtifactRef),
    coverage: strings(raw.coverage, "Wiki delegate receipt coverage"),
    gaps: raw.gaps.map(parseWikiDelegateGap),
    ...(error ? { error } : {}),
    attempts: raw.attempts as number,
    ...(review ? { review } : {}),
    contractId,
    contractDigest,
  };
}

/** Remove durable contract and artifact identities before crossing the public API boundary. */
export function projectWikiAgentOutcome(value: unknown): WikiAgentOutcome {
  const receipt = parseWikiDelegateReceipt(value);
  return {
    id: receipt.id,
    role: receipt.role,
    status: receipt.status,
    summary: receipt.summary,
    coverage: [...receipt.coverage],
    gaps: structuredClone(receipt.gaps),
    ...(receipt.error ? { error: { ...receipt.error } } : {}),
    attempts: receipt.attempts,
    ...(receipt.review ? { review: structuredClone(receipt.review) } : {}),
  };
}

/** Lead-visible batch snapshot: no contract identity or full artifact records. */
export function projectWikiLeadSnapshot(snapshot: WikiDelegateBatchSnapshot): {
  batchId: number;
  status: WikiDelegateBatchSnapshot["status"];
  pendingTaskIds: string[];
  receipts: Array<WikiAgentOutcome & { outputs: { nodeId: string }[] }>;
} {
  return {
    batchId: snapshot.batchId,
    status: snapshot.status,
    pendingTaskIds: [...snapshot.pendingTaskIds],
    receipts: snapshot.receipts.map((receipt) => ({
      ...projectWikiAgentOutcome(receipt),
      outputs: receipt.outputs.map((output) => ({ nodeId: output.nodeId })),
    })),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unknown fields`);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) throw new Error(`Invalid ${label}`);
  return [...value];
}

function nonEmptyStrings(value: unknown, label: string): string[] {
  const result = strings(value, label);
  if (!result.length) throw new Error(`${label} must not be empty`);
  return result;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function parseWikiArtifactRef(value: unknown): WikiArtifactRef {
  const raw = record(value, "Wiki artifact reference");
  exactKeys(raw, ["version", "runId", "nodeId", "attempt", "kind", "relativePath", "sha256", "sizeBytes", "mediaType"], "Wiki artifact reference");
  if (raw.version !== 1 || raw.kind !== "research" || raw.mediaType !== "text/markdown"
    || !Number.isSafeInteger(raw.attempt) || (raw.attempt as number) < 1 || !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 0) throw new Error("Invalid Wiki artifact reference");
  const sha256 = digest(raw.sha256, "Wiki artifact digest");
  if (raw.relativePath !== `.okf-wiki/blobs/${sha256}.md`) throw new Error("Invalid Wiki artifact path");
  return { version: 1, runId: safeId(raw.runId, "Wiki artifact run id"), nodeId: safeId(raw.nodeId, "Wiki artifact node id"), attempt: raw.attempt as number, kind: "research", relativePath: raw.relativePath, sha256, sizeBytes: raw.sizeBytes as number, mediaType: "text/markdown" };
}

export function parseWikiDelegateGap(value: unknown): WikiDelegateGap {
  const raw = record(value, "Wiki delegate gap");
  exactKeys(raw, ["question", "sourceScopeIds"], "Wiki delegate gap");
  return { question: nonEmpty(raw.question, "Wiki delegate gap question"), ...(raw.sourceScopeIds === undefined ? {} : { sourceScopeIds: strings(raw.sourceScopeIds, "Wiki delegate gap sourceScopeIds") }) };
}

function assertAssignedWikiPaths(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value) => !safeAssignedWikiPath(value))) throw new Error(`Invalid Wiki ${label}`);
}
function safeAssignedWikiPath(value: string): boolean {
  return value.startsWith("wiki/") && isSafeWikiPagePath(value.slice("wiki/".length));
}

function hashContract(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
