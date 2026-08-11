import type { WikiNodeErrorCode, WikiNodeHistoryEntry } from "./workflow-types.js";

export type SubmissionToolName =
  | "wiki_submit_research"
  | "wiki_submit_synthesis"
  | "wiki_submit_page"
  | "wiki_submit_review";

export type SubmissionFailureCode = "invalid_submission" | "submission_too_large" | "validator_infrastructure";

/** Agent-facing error codes; same vocabulary as durable node errors. */
export type WikiAgentErrorCode = WikiNodeErrorCode;

export interface SubmissionFailure {
  code: SubmissionFailureCode;
  message: string;
}

/** A node ended without the tool submission required to advance the Wiki DAG. */
export class WikiAgentProtocolError extends Error {
  readonly code: "missing_submission" | SubmissionFailureCode;

  constructor(
    readonly requiredSubmissionTool: SubmissionToolName,
    readonly output: string,
    readonly history: WikiNodeHistoryEntry[],
    failure?: SubmissionFailure,
  ) {
    super(failure
      ? `Agent could not complete ${requiredSubmissionTool}: ${failure.message}`
      : `Agent did not call ${requiredSubmissionTool} before completing`);
    this.name = "WikiAgentProtocolError";
    this.code = failure?.code ?? "missing_submission";
  }
}

/** Context overflow / compaction recovery exhausted for this agent attempt. */
export class WikiAgentContextBudgetError extends Error {
  readonly code = "context_budget_exceeded" as const;

  constructor(
    readonly output: string,
    readonly history: WikiNodeHistoryEntry[],
    message: string,
  ) {
    super(message);
    this.name = "WikiAgentContextBudgetError";
  }
}

/** Detect Pi / provider messages that mean the context budget was exhausted. */
export function isContextBudgetMessage(message: string | undefined): boolean {
  if (!message) return false;
  return /overflow|compaction failed|auto-compaction failed|context (?:length|window)|context overflow recovery failed/i
    .test(message);
}
