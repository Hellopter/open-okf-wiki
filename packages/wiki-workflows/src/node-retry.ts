import {
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
} from "./agent-errors.js";
import type { WikiNodeError, WikiNodeErrorCode, WikiNodeStatus, WikiRunStatus } from "./workflow-types.js";

export interface NodeFailureClassification {
  status: Extract<WikiNodeStatus, "queued" | "failed" | "blocked" | "cancelled">;
  error: WikiNodeError;
  /** When set, the run should leave running/paused and become this terminal status. */
  terminalRun?: Extract<WikiRunStatus, "failed" | "blocked">;
  retryable: boolean;
}

export interface ClassifyNodeFailureOptions {
  attempt: number;
  maxAttempts: number;
  aborted: boolean;
}

/**
 * Pure policy: map an execution error onto node status and optional run terminal.
 * Keeps engine catch blocks free of scattered retry rules.
 */
export function classifyNodeFailure(error: unknown, options: ClassifyNodeFailureOptions): NodeFailureClassification {
  if (options.aborted) {
    return {
      status: "cancelled",
      error: { message: errorMessage(error), code: "cancelled" satisfies WikiNodeErrorCode },
      retryable: false,
    };
  }

  if (isLoopBudgetError(error)) {
    return {
      status: "blocked",
      error: { message: errorMessage(error), code: "execution_failed" satisfies WikiNodeErrorCode, retryable: false },
      terminalRun: "blocked",
      retryable: false,
    };
  }

  if (error instanceof WikiAgentProtocolError && error.code === "validator_infrastructure") {
    if (options.attempt < options.maxAttempts) {
      return {
        status: "queued",
        error: {
          message: error.message,
          code: error.code,
          requiredSubmissionTool: error.requiredSubmissionTool,
          retryable: true,
        },
        retryable: true,
      };
    }
    return {
      status: "failed",
      error: {
        message: error.message,
        code: error.code,
        requiredSubmissionTool: error.requiredSubmissionTool,
        retryable: false,
      },
      terminalRun: "failed",
      retryable: false,
    };
  }

  if (error instanceof WikiAgentContextBudgetError || isContextBudgetError(error)) {
    const message = errorMessage(error);
    if (options.attempt < options.maxAttempts) {
      return {
        status: "queued",
        error: { message, code: "context_budget_exceeded" satisfies WikiNodeErrorCode, retryable: true },
        retryable: true,
      };
    }
    return {
      status: "blocked",
      error: { message, code: "context_budget_exceeded" satisfies WikiNodeErrorCode, retryable: false },
      terminalRun: "blocked",
      retryable: false,
    };
  }

  if (error instanceof WikiAgentProtocolError) {
    return {
      status: "failed",
      error: {
        message: error.message,
        code: error.code satisfies WikiNodeErrorCode,
        requiredSubmissionTool: error.requiredSubmissionTool,
        retryable: false,
      },
      terminalRun: "failed",
      retryable: false,
    };
  }

  return {
    status: "failed",
    error: { message: errorMessage(error), code: "execution_failed" satisfies WikiNodeErrorCode, retryable: false },
    terminalRun: "failed",
    retryable: false,
  };
}

function isContextBudgetError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "context_budget_exceeded";
}

function isLoopBudgetError(error: unknown): boolean {
  return /Research reached the \d+-round limit/.test(errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
