/**
 * Host-side ExecutionPlan compiler (Phase 1 hard-cut).
 *
 * WikiRunSpec is content/acceptance only. Topology caps are enforced here:
 * over maxDomainFanOut / maxLeafFanOut → throw (never silent `.slice`).
 */

import {
  DEFAULT_ORCHESTRATION,
  type ExecutionPlan,
  ExecutionPlanSchema,
  type WikiRunSpec,
} from "@okf-wiki/contract";

export const REVIEW_LENSES = ["grounding", "coverage", "consistency", "general"] as const;

export type CompileExecutionPlanCaps = {
  maxDomainFanOut?: number;
  maxLeafFanOut?: number;
  reviewCouncilSize?: number;
  /** Optional Spec content digest to record on the plan. */
  specDigest?: string;
};

export class ExecutionPlanCompileError extends Error {
  readonly code = "EXECUTION_PLAN_COMPILE";

  constructor(message: string) {
    super(message);
    this.name = "ExecutionPlanCompileError";
  }
}

/**
 * Compile a sealed ExecutionPlan from an approved (or plan-success) WikiRunSpec.
 * Fail-closed on fan-out caps — callers must not truncate Spec domains/questions.
 */
export function compileExecutionPlan(
  spec: WikiRunSpec,
  caps?: CompileExecutionPlanCaps,
): ExecutionPlan {
  const maxDomainFanOut = Math.max(
    1,
    Math.min(16, Math.floor(caps?.maxDomainFanOut ?? DEFAULT_ORCHESTRATION.maxDomainFanOut)),
  );
  const maxLeafFanOut = Math.max(
    1,
    Math.min(16, Math.floor(caps?.maxLeafFanOut ?? DEFAULT_ORCHESTRATION.maxLeafFanOut)),
  );
  const reviewRequired = spec.acceptance?.reviewRequired !== false;
  const councilSize = reviewRequired
    ? Math.max(
        1,
        Math.min(
          REVIEW_LENSES.length,
          Math.floor(caps?.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize),
        ),
      )
    : 0;
  // Empty lenses only when reviewRequired=false — graph skips seats; reduce fail-closes if required.
  const reviewLenses = REVIEW_LENSES.slice(0, councilSize).map((lens) => lens);

  const domains = spec.domains ?? [];
  if (domains.length > maxDomainFanOut) {
    throw new ExecutionPlanCompileError(
      `WikiRunSpec has ${domains.length} domains but maxDomainFanOut is ${maxDomainFanOut}; ` +
        `reduce domains in the Spec or raise workspace.orchestration.maxDomainFanOut ` +
        `(silent truncation is not allowed)`,
    );
  }

  const workUnits: ExecutionPlan["workUnits"] = [];
  const reductions: ExecutionPlan["reductions"] = [];
  let leafCount = 0;

  for (const domain of domains) {
    const domainId = domain.id.trim();
    if (!domainId) {
      throw new ExecutionPlanCompileError("WikiRunSpec domain id must be non-empty");
    }
    const questions = (domain.questions ?? [])
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    if (questions.length > maxLeafFanOut) {
      throw new ExecutionPlanCompileError(
        `Domain "${domainId}" has ${questions.length} questions but maxLeafFanOut is ${maxLeafFanOut}; ` +
          `reduce questions or raise workspace.orchestration.maxLeafFanOut ` +
          `(silent truncation is not allowed)`,
      );
    }

    const scope = (domain.scope?.trim() || domain.title?.trim() || domainId).slice(0, 2_000);
    const leafIds: string[] = [];

    if (questions.length === 0) {
      // Domains without questions still get one leaf so domain reduce has input.
      const id = `leaf:${domainId}:1`;
      leafIds.push(id);
      workUnits.push({
        id,
        domainId,
        questions: [],
        scope,
        kind: "leaf",
      });
      leafCount += 1;
    } else {
      questions.forEach((question, index) => {
        const id = `leaf:${domainId}:${index + 1}`;
        leafIds.push(id);
        workUnits.push({
          id,
          domainId,
          questions: [question],
          scope,
          kind: "leaf",
        });
        leafCount += 1;
      });
    }

    // Record reduction structure when a domain has multiple leaves.
    if (leafIds.length > 1) {
      reductions.push({
        id: `reduce:${domainId}`,
        childWorkUnitIds: leafIds,
        domainId,
      });
    }
  }

  return ExecutionPlanSchema.parse({
    version: 1,
    workUnits,
    reductions,
    reviewLenses,
    budgets: {
      maxRepairRounds: spec.acceptance?.maxRepairRounds ?? 2,
      maxHardValidateRepairRounds: spec.acceptance?.maxHardValidateRepairRounds ?? 0,
    },
    fanOut: {
      domainCount: domains.length,
      leafCount,
      maxDomainFanOut,
      maxLeafFanOut,
    },
    ...(caps?.specDigest ? { specDigest: caps.specDigest } : {}),
  });
}
