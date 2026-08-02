/**
 * Host-side ExecutionPlan compiler (Phase 1 hard-cut).
 *
 * WikiRunSpec is content/acceptance only. Topology caps are enforced here:
 * over maxDomainFanOut / maxLeafFanOut → throw (never silent `.slice`).
 */

import {
  assertSpecWithinFanOutCaps,
  DEFAULT_ORCHESTRATION,
  type ExecutionPlan,
  ExecutionPlanSchema,
  resolveSpecFanOutCaps,
  SpecFanOutCapError,
  type WikiRunSpec,
} from "@okf-wiki/contract";

export const REVIEW_LENSES = ["grounding", "coverage", "consistency", "general"] as const;

export type CompileExecutionPlanCaps = {
  maxDomainFanOut?: number;
  maxLeafFanOut?: number;
  reviewCouncilSize?: number;
  /** Whether the frozen plan needs a bounded evidence-gap adaptation pass. */
  adaptationRequired?: boolean;
  /** Optional Spec content digest to record on the plan. */
  specDigest?: string;
};

export class ExecutionPlanCompileError extends Error {
  readonly code = "EXECUTION_PLAN_COMPILE";
  /** Typed for failNode / L_control — fan-out and domain id product errors are schema. */
  readonly failureClass = "schema" as const;

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
  const { maxDomainFanOut, maxLeafFanOut } = resolveSpecFanOutCaps(caps);
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
  try {
    assertSpecWithinFanOutCaps(spec, { maxDomainFanOut, maxLeafFanOut });
  } catch (err) {
    if (err instanceof SpecFanOutCapError) {
      throw new ExecutionPlanCompileError(err.message);
    }
    throw err;
  }

  const workUnits: ExecutionPlan["workUnits"] = [];
  let leafCount = 0;

  for (const domain of domains) {
    const domainId = domain.id.trim();
    if (!domainId) {
      throw new ExecutionPlanCompileError("WikiRunSpec domain id must be non-empty");
    }
    const questions = (domain.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0);

    const scope = (domain.scope?.trim() || domain.title?.trim() || domainId).slice(0, 2_000);
    if (questions.length === 0) {
      // Domains without questions still get one leaf so domain reduce has input.
      const id = `leaf:${domainId}:1`;
      workUnits.push({
        id,
        domainId,
        questions: [],
        scope,
      });
      leafCount += 1;
    } else {
      questions.forEach((question, index) => {
        const id = `leaf:${domainId}:${index + 1}`;
        workUnits.push({
          id,
          domainId,
          questions: [question],
          scope,
        });
        leafCount += 1;
      });
    }
  }

  // In the live path this is derived from inventory + planner uncertainty.
  // Direct compiler consumers retain a deterministic, evidence-shaped default.
  const adaptationRequired =
    caps?.adaptationRequired ??
    (leafCount > 1 || (spec.openQuestions ?? []).some((question) => question.trim().length > 0));

  return ExecutionPlanSchema.parse({
    version: 4,
    workUnits,
    reviewLenses,
    fanOut: {
      domainCount: domains.length,
      leafCount,
      maxDomainFanOut,
      maxLeafFanOut,
    },
    adaptation: { required: adaptationRequired, maxRounds: adaptationRequired ? 2 : 0 },
    ...(caps?.specDigest ? { specDigest: caps.specDigest } : {}),
  });
}
