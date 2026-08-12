import {
  WikiAgentContextBudgetError,
  WikiAgentProtocolError,
} from "./agent-errors.js";
import {
  budgetExhaustedCode,
  errorMessage,
  isWikiBudgetExhaustedError,
  type WikiNodeErrorCode,
} from "./failures.js";
import type { WikiNodeError, WikiNodeStatus, WikiRunStatus } from "./workflow-types.js";

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
  /** Total node sessions allowed for transient/context failures, including the first. */
  maxTransientSessionAttempts?: number;
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

  if (isWikiBudgetExhaustedError(error)) {
    const code = budgetExhaustedCode(error);
    return {
      status: "blocked",
      error: { message: errorMessage(error), code, retryable: false },
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
    if (freshSessionRetryAvailable(options)) {
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

  if (isTransientProviderError(error)) {
    const message = errorMessage(error);
    if (freshSessionRetryAvailable(options)) {
      return {
        status: "queued",
        error: { message, code: "execution_failed" satisfies WikiNodeErrorCode, retryable: true },
        retryable: true,
      };
    }
    return {
      status: "failed",
      error: { message, code: "execution_failed" satisfies WikiNodeErrorCode, retryable: false },
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

/** Pi owns the in-session retries; the workflow may create only one fresh session. */
function freshSessionRetryAvailable(options: ClassifyNodeFailureOptions): boolean {
  const sessionLimit = options.maxTransientSessionAttempts ?? 2;
  return options.attempt < sessionLimit && options.attempt < options.maxAttempts;
}

function isTransientProviderError(error: unknown): boolean {
  const message = errorMessage(error);
  if (/insufficient[_ -]?quota|quota (?:exhausted|exceeded)|exceeded your (?:current )?quota|credit balance|billing|authentication|unauthorized|forbidden|invalid (?:request|api key)|\b(?:401|403)\b/i.test(message)) {
    return false;
  }
  return /\b429\b|too many requests|rate limit|overloaded|service unavailable|bad gateway|gateway timeout|internal server error|\b50[0-4]\b|econnreset|etimedout|timed? out|timeout|socket hang up/i.test(message);
}
