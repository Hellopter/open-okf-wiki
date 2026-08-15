import type { WikiArtifactRef } from "./artifact-store.js";
import type { WikiBudgetExhaustedCode } from "./failures.js";
import type { WikiReviewResult } from "./workflow-state.js";

export type WikiDelegateRole = "research" | "write" | "review";

export interface WikiDelegateTask {
  id: string;
  role: WikiDelegateRole;
  instruction: string;
  sourceScopeIds: string[];
  contextRefs: string[];
  writePaths?: string[];
  reviewPaths?: string[];
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
      status?: number;
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
