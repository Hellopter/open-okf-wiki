import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  SubmissionFailure,
  SubmissionFailureCode,
  SubmissionIssue,
  SubmissionToolName,
} from "./agent-errors.js";
import type { WorkspaceToolPolicy } from "./path-policy.js";
import {
  parseResearchSubmission,
  parseReviewSubmission,
  parseSynthesisSubmission,
  researchSubmissionSchema,
  reviewSubmissionSchema,
  synthesisExpandSubmissionSchema,
  synthesisFinalizeSubmissionSchema,
  WikiControlSubmissionSizeError,
} from "./control-submissions.js";
import { loadResearchSourceRoots, validateResearchArtifact } from "./research-evidence.js";
import { submissionContractGuidance } from "./submissions/contracts.js";
import type {
  WikiAgentExecutionRequest,
  WikiControlSubmission,
} from "./workflow-types.js";

export type { SubmissionToolName, SubmissionFailure, SubmissionFailureCode, SubmissionIssue };
export { submissionContractGuidance };

/** Upper bound for configurable in-context submission opportunities. */
export const MAX_SUBMISSIONS_PER_ATTEMPT = 3;

export interface SubmissionCollector {
  toolNames: readonly SubmissionToolName[];
  acceptedToolName?: SubmissionToolName;
  pagePath?: string;
  value?: unknown;
  failure?: SubmissionFailure;
  submissionAttempts: number;
  maxSubmissions: number;
  exhausted?: boolean;
  pendingAttempt?: Promise<void>;
  validate?: (submission: WikiControlSubmission) => void;
  validatePage?: WikiAgentExecutionRequest["validatePageSubmission"];
}

export function submissionFor(request: WikiAgentExecutionRequest): SubmissionCollector | undefined {
  const maxSubmissions = request.maxSubmissionAttempts ?? MAX_SUBMISSIONS_PER_ATTEMPT;
  if (!Number.isInteger(maxSubmissions) || maxSubmissions < 1 || maxSubmissions > MAX_SUBMISSIONS_PER_ATTEMPT) {
    throw new Error(`Workflow configuration error: maxSubmissionAttempts must be an integer from 1 to ${MAX_SUBMISSIONS_PER_ATTEMPT}`);
  }
  const base = { submissionAttempts: 0, maxSubmissions };
  if (request.node.kind === "write") {
    if (!request.validatePageSubmission || request.writePaths?.length !== 1) {
      throw new Error("Workflow configuration error: writers require one page submission validator");
    }
    const pagePath = request.writePaths[0]!.replace(/^wiki\//, "");
    return { ...base, toolNames: ["wiki_submit_page"], pagePath, validatePage: request.validatePageSubmission };
  }
  if (request.node.kind === "research") return { ...base, toolNames: ["wiki_submit_research"] };
  if (request.node.kind === "synthesis") {
    return { ...base, toolNames: ["wiki_submit_synthesis_expand", "wiki_submit_synthesis_finalize"], validate: request.validateControlSubmission };
  }
  if (request.node.kind === "review") {
    return { ...base, toolNames: ["wiki_submit_review"], validate: request.validateControlSubmission };
  }
  return undefined;
}

export interface SubmissionToolOptions {
  /** Scope-authorized source roots for research evidence validation. */
  allowedSourceRoots?: readonly string[];
}

export function submissionTools(
  policy: WorkspaceToolPolicy,
  submission: SubmissionCollector,
  options: SubmissionToolOptions = {},
): ToolDefinition<any, any, any>[] {
  return submission.toolNames.map((toolName) => submissionTool(policy, submission, toolName, options));
}

function submissionTool(
  policy: WorkspaceToolPolicy,
  submission: SubmissionCollector,
  toolName: SubmissionToolName,
  options: SubmissionToolOptions,
): ToolDefinition<any, any, any> {
  if (toolName === "wiki_submit_page") return pageSubmissionTool(submission);

  const parser = toolName === "wiki_submit_research" ? parseResearchSubmission
    : toolName === "wiki_submit_synthesis_expand" ? (value: unknown) => parseSynthesisSubmission({ ...(value as object), decision: "expand" })
      : toolName === "wiki_submit_synthesis_finalize" ? (value: unknown) => parseSynthesisSubmission({ ...(value as object), decision: "finalize" })
      : parseReviewSubmission;
  const parameters = toolName === "wiki_submit_research" ? researchSubmissionSchema
    : toolName === "wiki_submit_synthesis_expand" ? synthesisExpandSubmissionSchema
      : toolName === "wiki_submit_synthesis_finalize" ? synthesisFinalizeSubmissionSchema
      : reviewSubmissionSchema;
  const role = toolName === "wiki_submit_research" ? "research result"
    : toolName === "wiki_submit_synthesis_expand" ? "targeted research expansion"
      : toolName === "wiki_submit_synthesis_finalize" ? "final Wiki plan"
      : "semantic review";

  return {
    name: toolName,
    label: toolName,
    description: `Submit the complete typed ${role} directly. ${submissionContractGuidance(toolName)}`,
    promptSnippet: `Submit the typed Wiki ${role}`,
    promptGuidelines: [
      "Pass the complete result object directly. If rejected and attempts remain, fix every returned issue and resubmit in this session. Stop after acceptance or when the tool reports that the budget is exhausted.",
    ],
    parameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params) {
      const result = await attemptSubmission(submission, toolName, async () => {
        const parsed = parser(params) as WikiControlSubmission;
        if (toolName === "wiki_submit_research") {
          const allowedSourceRoots = options.allowedSourceRoots ?? [];
          validateResearchArtifact(parsed as ReturnType<typeof parseResearchSubmission>, {
            cwd: policy.workspaceRoot,
            allowedSourceRoots,
            sourceRoots: await loadResearchSourceRoots(policy.workspaceRoot, allowedSourceRoots),
          });
        }
        submission.validate?.(parsed);
        return parsed;
      });
      return submissionToolResult(result, `Wiki ${role} accepted.`);
    },
  };
}

function pageSubmissionTool(submission: SubmissionCollector): ToolDefinition<any, any, any> {
  const pagePath = submission.pagePath!;
  return {
    name: "wiki_submit_page",
    label: "wiki_submit_page",
    description: `Validate and submit the assigned Wiki page ${pagePath}. Fix every reported issue and resubmit while attempts remain.`,
    promptSnippet: "Validate and submit the assigned Wiki page",
    promptGuidelines: ["After writing the page, call this tool. Fix every returned issue and resubmit while attempts remain. Stop after acceptance or budget exhaustion."],
    parameters: Type.Object({ page: Type.Literal(pagePath) }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params: { page: string }) {
      const result = await attemptSubmission(submission, "wiki_submit_page", async () => {
        if (params.page !== pagePath || !submission.validatePage) throw new Error("Page submission does not match the assigned page");
        let validation;
        try {
          validation = await submission.validatePage(pagePath);
        } catch (error) {
          throw new WikiPageValidatorInfrastructureError(error);
        }
        if (!validation.ok) throw new WikiPageValidationError(validation.issues);
        return validation.submission;
      });
      return submissionToolResult(result, `Wiki page accepted: ${pagePath}`);
    },
  };
}

export type SubmissionAttemptResult =
  | { accepted: true }
  | { accepted: false; issues: SubmissionIssue[]; remainingAttempts: number; exhausted: boolean };

export async function attemptSubmission(
  submission: SubmissionCollector,
  toolName: SubmissionToolName,
  parse: () => unknown | Promise<unknown>,
): Promise<SubmissionAttemptResult> {
  const previousAttempt = submission.pendingAttempt ?? Promise.resolve();
  let releaseAttempt!: () => void;
  submission.pendingAttempt = new Promise<void>((resolve) => {
    releaseAttempt = resolve;
  });
  await previousAttempt;
  try {
    return await attemptSubmissionLocked(submission, toolName, parse);
  } finally {
    releaseAttempt();
  }
}

async function attemptSubmissionLocked(
  submission: SubmissionCollector,
  toolName: SubmissionToolName,
  parse: () => unknown | Promise<unknown>,
): Promise<SubmissionAttemptResult> {
  if (submission.value !== undefined) {
    return terminalRejection(submission, [{ path: "$", code: "already_accepted", message: `${submission.acceptedToolName ?? "A submission tool"} was already accepted` }]);
  }
  if (submission.submissionAttempts >= submission.maxSubmissions) {
    return rejection(submission, [{ path: "$", code: "submission_budget_exhausted", message: `No submission attempts remain for ${submission.toolNames.join(" or ")}` }], true);
  }
  submission.submissionAttempts += 1;
  try {
    submission.value = structuredClone(await parse());
    submission.acceptedToolName = toolName;
    submission.failure = undefined;
    submission.exhausted = false;
    return { accepted: true };
  } catch (error) {
    if (error instanceof WikiPageValidatorInfrastructureError) {
      submission.failure = { code: "validator_infrastructure", message: error.message };
      throw error;
    }
    const issues = issuesFor(error);
    const exhausted = submission.submissionAttempts >= submission.maxSubmissions;
    return rejection(submission, issues, exhausted);
  }
}

function terminalRejection(submission: SubmissionCollector, issues: SubmissionIssue[]): SubmissionAttemptResult {
  return {
    accepted: false,
    issues,
    remainingAttempts: Math.max(0, submission.maxSubmissions - submission.submissionAttempts),
    exhausted: true,
  };
}

function rejection(submission: SubmissionCollector, issues: SubmissionIssue[], exhausted: boolean): SubmissionAttemptResult {
  const code: SubmissionFailureCode = issues.some((issue) => issue.code === "submission_too_large")
    ? "submission_too_large"
    : "invalid_submission";
  const remainingAttempts = Math.max(0, submission.maxSubmissions - submission.submissionAttempts);
  submission.exhausted = exhausted;
  submission.failure = {
    code,
    message: issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    issues,
    attempts: submission.submissionAttempts,
    remainingAttempts,
  };
  return {
    accepted: false,
    issues,
    remainingAttempts,
    exhausted,
  };
}

function issuesFor(error: unknown): SubmissionIssue[] {
  if (error instanceof WikiPageValidationError) {
    return error.issues.map((issue) => ({ path: "$.page", code: issue.code, message: issue.message }));
  }
  const message = error instanceof Error ? error.message : String(error);
  return [{
    path: issuePathFor(message),
    code: error instanceof WikiControlSubmissionSizeError ? "submission_too_large" : "invalid_value",
    message,
  }];
}

function issuePathFor(message: string): string {
  if (/finding/i.test(message)) return "$.findings";
  if (/gap/i.test(message)) return "$.gaps";
  if (/defect|review/i.test(message)) return "$.defects";
  if (/WikiSpec|synthesis|domain|page/i.test(message)) return "$.spec";
  return "$";
}

function submissionToolResult(result: SubmissionAttemptResult, acceptedMessage: string) {
  const text = result.accepted ? acceptedMessage : JSON.stringify(result);
  return { content: [{ type: "text" as const, text }], details: result, terminate: result.accepted || result.exhausted };
}

class WikiPageValidationError extends Error {
  constructor(readonly issues: Array<{ code: string; message: string }>) {
    super(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"));
  }
}

class WikiPageValidatorInfrastructureError extends Error {
  constructor(cause: unknown) {
    super(`Page validator infrastructure failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
