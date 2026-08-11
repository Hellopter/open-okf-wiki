import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  SubmissionFailure,
  SubmissionFailureCode,
  SubmissionToolName,
} from "./agent-errors.js";
import {
  readArtifactText,
  resolveArtifactPath,
  writeArtifactText,
  type WorkspaceToolPolicy,
} from "./path-policy.js";
import {
  artifactSubmissionSchema,
  parseArtifactSubmission,
  parseResearchArtifact,
  parseReviewArtifact,
  parseSynthesisArtifact,
  WikiControlSubmissionSizeError,
} from "./control-submissions.js";
import { loadResearchSourceRoots, validateResearchArtifact } from "./research-evidence.js";
import { submissionContractGuidance } from "./submissions/contracts.js";
import type {
  WikiAgentExecutionRequest,
  WikiControlSubmission,
} from "./workflow-types.js";

export type { SubmissionToolName, SubmissionFailure, SubmissionFailureCode };
export { submissionContractGuidance };

export interface SubmissionCollector {
  toolName: SubmissionToolName;
  artifactPath?: string;
  pagePath?: string;
  value?: unknown;
  failure?: SubmissionFailure;
  validate?: (submission: WikiControlSubmission) => void;
  validatePage?: WikiAgentExecutionRequest["validatePageSubmission"];
}

export function submissionFor(request: WikiAgentExecutionRequest): SubmissionCollector | undefined {
  if (request.node.kind === "write") {
    if (!request.validatePageSubmission || request.writePaths?.length !== 1) {
      throw new Error("Workflow configuration error: writers require one page submission validator");
    }
    const pagePath = request.writePaths[0]!.replace(/^wiki\//, "");
    return { toolName: "wiki_submit_page", pagePath, validatePage: request.validatePageSubmission };
  }
  if (request.node.kind !== "research" && request.node.kind !== "synthesis" && request.node.kind !== "review") return undefined;
  if (!request.artifactWritePath) throw new Error(`Workflow configuration error: ${request.node.kind} requires an artifact write path`);
  if (request.node.kind === "research") {
    return { toolName: "wiki_submit_research", artifactPath: request.artifactWritePath };
  }
  if (request.node.kind === "synthesis") {
    return { toolName: "wiki_submit_synthesis", artifactPath: request.artifactWritePath, validate: request.validateControlSubmission };
  }
  if (request.node.kind === "review") {
    return { toolName: "wiki_submit_review", artifactPath: request.artifactWritePath, validate: request.validateControlSubmission };
  }
  return undefined;
}

export interface SubmissionToolOptions {
  /** Scope-authorized source roots for research evidence validation. */
  allowedSourceRoots?: readonly string[];
}

export function submissionTool(
  policy: WorkspaceToolPolicy,
  submission: SubmissionCollector,
  options: SubmissionToolOptions = {},
): ToolDefinition<any, any, any> {
  if (submission.toolName === "wiki_submit_page") {
    const pagePath = submission.pagePath!;
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: `Validate and submit the assigned Wiki page ${pagePath}. Fix every reported issue and resubmit until accepted.`,
      promptSnippet: "Validate and submit the assigned Wiki page",
      promptGuidelines: ["After writing the page, call this tool. If it reports issues, fix all of them and call it again. Stop only after the page is accepted."],
      parameters: Type.Object({ page: Type.Literal(pagePath) }, { additionalProperties: false }),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params: { page: string }) {
        await recordSubmission(submission, async () => {
          if (params.page !== pagePath || !submission.validatePage) throw new Error("Page submission does not match the assigned page");
          let result;
          try {
            result = await submission.validatePage(pagePath);
          } catch (error) {
            throw new WikiPageValidatorInfrastructureError(error);
          }
          if (!result.ok) throw new Error(result.issues.map((issue) => `[${issue.code}] ${issue.message}`).join("\n"));
          return result.submission;
        });
        return { content: [{ type: "text", text: `Wiki page accepted: ${pagePath}` }], details: undefined, terminate: true };
      },
    };
  }
  if (submission.toolName === "wiki_submit_research") {
    const artifactPath = submission.artifactPath!;
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: `Submit the structured research result from ${artifactPath}. ${submissionContractGuidance(submission.toolName)}`,
      promptSnippet: "Submit the structured Wiki research result",
      promptGuidelines: [`Write the complete JSON handoff artifact, then submit its exact path. ${submissionContractGuidance(submission.toolName)} Correct and resubmit if rejected; after it is recorded, stop.`],
      parameters: artifactSubmissionSchema(artifactPath),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params) {
        await recordSubmission(submission, async () => {
          const submittedPath = parseArtifactSubmission(params, artifactPath);
          const parsed = parseResearchArtifact(await readArtifactText(policy, submittedPath));
          const allowedSourceRoots = options.allowedSourceRoots ?? [];
          validateResearchArtifact(parsed, {
            cwd: policy.workspaceRoot,
            allowedSourceRoots,
            sourceRoots: await loadResearchSourceRoots(policy.workspaceRoot, allowedSourceRoots),
          });
          return parsed;
        });
        return { content: [{ type: "text", text: "Wiki research recorded." }], details: undefined, terminate: true };
      },
    };
  }
  if (submission.toolName === "wiki_submit_synthesis") {
    const artifactPath = submission.artifactPath!;
    return {
      name: submission.toolName,
      label: submission.toolName,
      description: `Submit the synthesis result by referencing the exact JSON handoff artifact written for this node. ${submissionContractGuidance(submission.toolName)}`,
      promptSnippet: "Submit the Wiki synthesis decision",
      promptGuidelines: [`Write the complete JSON handoff artifact, then submit its exact path. ${submissionContractGuidance(submission.toolName)} Correct and resubmit if rejected; after it is recorded, stop.`],
      parameters: artifactSubmissionSchema(artifactPath),
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(_toolCallId, params) {
        await recordSubmission(submission, async () => {
          const submittedPath = parseArtifactSubmission(params, artifactPath);
          const parsed = parseSynthesisArtifact(await readArtifactText(policy, submittedPath));
          submission.validate?.(parsed);
          return parsed;
        });
        return { content: [{ type: "text", text: "Wiki synthesis recorded." }], details: undefined, terminate: true };
      },
    };
  }
  return {
    name: submission.toolName,
    label: submission.toolName,
    description: `Submit the review result by referencing the exact JSON handoff artifact written for this node. ${submissionContractGuidance(submission.toolName)}`,
    promptSnippet: "Submit the final Wiki review",
    promptGuidelines: [`Write the complete JSON handoff artifact, then submit its exact path. ${submissionContractGuidance(submission.toolName)} Correct and resubmit if rejected; after it is recorded, stop.`],
    parameters: artifactSubmissionSchema(submission.artifactPath!),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(_toolCallId, params) {
      await recordSubmission(submission, async () => {
        const artifactPath = parseArtifactSubmission(params, submission.artifactPath!);
        const parsed = parseReviewArtifact(await readArtifactText(policy, artifactPath));
        submission.validate?.(parsed);
        return parsed;
      });
      return { content: [{ type: "text", text: "Wiki review recorded." }], details: undefined, terminate: true };
    },
  };
}

export async function recordSubmission(
  submission: SubmissionCollector,
  parse: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    if (submission.value !== undefined) throw new Error(`${submission.toolName} may only be called once per node attempt`);
    submission.value = structuredClone(await parse());
    submission.failure = undefined;
  } catch (error) {
    submission.failure = {
      code: error instanceof WikiControlSubmissionSizeError ? "submission_too_large"
        : error instanceof WikiPageValidatorInfrastructureError ? "validator_infrastructure"
          : "invalid_submission",
      message: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

class WikiPageValidatorInfrastructureError extends Error {
  constructor(cause: unknown) {
    super(`Page validator infrastructure failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const artifactWriteSchema = Type.Object({
  content: Type.String({ description: "Complete Markdown or JSON handoff content for this node's assigned artifact" }),
}, { additionalProperties: false });

/** Write only the engine-assigned handoff file; the model never chooses its path. */
export function createArtifactWriteToolDefinition(
  policy: WorkspaceToolPolicy,
  artifactPath: string,
  submissionToolName?: SubmissionToolName,
): ToolDefinition<typeof artifactWriteSchema> {
  const expectedPath = resolveArtifactPath(policy, artifactPath);
  const contract = submissionToolName ? submissionContractGuidance(submissionToolName) : undefined;
  return {
    name: "wiki_write_handoff",
    label: "wiki_write_handoff",
    description: `Write the complete handoff artifact at ${expectedPath}. This is the only handoff path available to this node.${contract ? ` ${contract}` : ""}`,
    promptSnippet: "Write the node handoff artifact",
    promptGuidelines: [`Write the complete artifact once it is ready. Do not write handoff data to any other path.${contract ? ` ${contract}` : ""}`],
    parameters: artifactWriteSchema,
    async execute(_toolCallId, params) {
      if (typeof params.content !== "string") throw new Error("Handoff artifact content must be text");
      await writeArtifactText(policy, expectedPath, params.content);
      return { content: [{ type: "text", text: `Handoff artifact recorded at ${expectedPath}.` }], details: undefined };
    },
  };
}
