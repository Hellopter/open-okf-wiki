import { z } from "zod";
import {
  DefectItemSchema,
  DefectSeveritySchema,
  type WikiRunSpecAcceptance,
} from "./run.js";

/** How a WikiCandidate tree was produced. */
export const WikiCandidateProducedBySchema = z.enum(["write", "repair", "mechanical_fix"]);
export type WikiCandidateProducedBy = z.infer<typeof WikiCandidateProducedBySchema>;

/**
 * One versioned wiki tree under evaluation (Writer / Repairer / mechanical fix output).
 * Lineage is parentCandidateId + round; digest binds the sealed tree content.
 */
export const WikiCandidateSchema = z
  .object({
    candidateId: z.string().trim().min(1),
    digest: z.string().trim().min(1),
    artifactId: z.string().trim().min(1),
    parentCandidateId: z.string().trim().min(1).optional(),
    producedBy: WikiCandidateProducedBySchema,
    round: z.number().int().min(0),
    /** ISO-8601 timestamp when known. */
    createdAt: z.string().datetime().optional(),
  })
  .strict();

export type WikiCandidate = z.infer<typeof WikiCandidateSchema>;

/** Deterministic mechanical validation issue codes. */
export const MechanicalIssueCodeSchema = z.enum([
  "citation_oob",
  "citation_unresolved",
  "citation_format",
  "missing_citation",
  "missing_frontmatter",
  "missing_critical_page",
  "symlink",
  "cap_exceeded",
  "other",
]);
export type MechanicalIssueCode = z.infer<typeof MechanicalIssueCodeSchema>;

/** Host auto-fix strategy hint for a mechanical issue (when autoFixable). */
export const MechanicalFixHintSchema = z.enum([
  "clamp_lines",
  "canonicalize_target",
  "regenerate_index",
  "none",
]);
export type MechanicalFixHint = z.infer<typeof MechanicalFixHintSchema>;

export const MechanicalIssueSchema = z
  .object({
    code: MechanicalIssueCodeSchema,
    path: z.string().trim().min(1).max(500).optional(),
    message: z.string().min(1).max(4000),
    /** Original validator line / raw detail for audit. */
    raw: z.string().max(8000).optional(),
    autoFixable: z.boolean(),
    fixHint: MechanicalFixHintSchema.optional(),
  })
  .strict();

export type MechanicalIssue = z.infer<typeof MechanicalIssueSchema>;

/**
 * Result of deterministic wiki-tree validation for one candidate.
 * `errors` mirrors issue messages for legacy ValidateWikiResult consumers.
 */
export const MechanicalReportSchema = z
  .object({
    candidateId: z.string().trim().min(1).optional(),
    ok: z.boolean(),
    issues: z.array(MechanicalIssueSchema).default([]),
    warnings: z.array(z.string()).default([]),
    pageCount: z.number().int().min(0).optional(),
    fileCount: z.number().int().min(0).optional(),
    citationCount: z.number().int().min(0).optional(),
    /** Compat mirror of issue messages (and any non-issue hard failures). */
    errors: z.array(z.string()).default([]),
  })
  .strict();

export type MechanicalReport = z.infer<typeof MechanicalReportSchema>;

export const RepairSourceSchema = z.enum(["mechanical", "semantic", "operator"]);
export type RepairSource = z.infer<typeof RepairSourceSchema>;

export const RepairScopeModeSchema = z.enum(["mechanical_only", "patch", "rewrite_scoped"]);
export type RepairScopeMode = z.infer<typeof RepairScopeModeSchema>;

/**
 * Flexible repair issue row: required `kind`, extra fields allowed for
 * mechanical / semantic / operator provenance without a rigid union yet.
 */
export const RepairIssueSchema = z
  .object({
    kind: z.enum(["mechanical", "semantic", "operator"]),
  })
  .passthrough();

export type RepairIssue = z.infer<typeof RepairIssueSchema>;

export const RepairScopeSchema = z
  .object({
    pages: z.array(z.string().trim().min(1).max(200)).default([]),
    mode: RepairScopeModeSchema,
  })
  .strict();

export type RepairScope = z.infer<typeof RepairScopeSchema>;

/**
 * Input to a Repairer attempt: which candidate to fix, why, and scope limits.
 */
export const RepairRequestSchema = z
  .object({
    requestId: z.string().trim().min(1),
    baselineCandidateId: z.string().trim().min(1),
    round: z.number().int().min(0),
    sources: z.array(RepairSourceSchema).min(1),
    issues: z.array(RepairIssueSchema).default([]),
    scope: RepairScopeSchema,
    /** Prior-round blocking defects kept sticky across re-review when policy allows. */
    priorBlocking: z.array(z.union([DefectItemSchema, z.unknown()])).optional(),
  })
  .strict();

export type RepairRequest = z.infer<typeof RepairRequestSchema>;

export const EvaluationReReviewSchema = z.enum(["always", "affected_lenses"]);
export type EvaluationReReview = z.infer<typeof EvaluationReReviewSchema>;

export const EvaluationOnExhaustedSchema = z.enum(["fail", "operator"]);
export type EvaluationOnExhausted = z.infer<typeof EvaluationOnExhaustedSchema>;

export const MechanicalAutoFixPolicySchema = z
  .object({
    canonicalizeCitations: z.boolean().default(true),
    clampCitationLines: z.boolean().default(true),
    clampLineSlack: z.number().int().min(0).max(5).default(1),
    regenerateIndexes: z.boolean().default(true),
  })
  .strict();

export type MechanicalAutoFixPolicy = z.infer<typeof MechanicalAutoFixPolicySchema>;

export const MechanicalEvaluationPolicySchema = z
  .object({
    requireCitations: z.boolean().default(true),
    requireCriticalPages: z.boolean().default(true),
    autoFix: MechanicalAutoFixPolicySchema.default(() => MechanicalAutoFixPolicySchema.parse({})),
    /** Model-backed mechanical repair budget (maps from maxHardValidateRepairRounds). */
    modelRepairBudget: z.number().int().min(0).max(8).default(0),
  })
  .strict();

export type MechanicalEvaluationPolicy = z.infer<typeof MechanicalEvaluationPolicySchema>;

export const SemanticEvaluationPolicySchema = z
  .object({
    reviewRequired: z.boolean().default(true),
    /** Council / semantic repair budget (maps from maxRepairRounds). */
    modelRepairBudget: z.number().int().min(0).max(8).default(2),
    reReview: EvaluationReReviewSchema.default("always"),
    stickyPriorBlocking: z.boolean().default(true),
    blockingSeverities: z.array(DefectSeveritySchema).optional(),
  })
  .strict();

export type SemanticEvaluationPolicy = z.infer<typeof SemanticEvaluationPolicySchema>;

export const RepairEvaluationPolicySchema = z
  .object({
    defaultMode: RepairScopeModeSchema.default("patch"),
    allowFullTreeRewrite: z.boolean().default(false),
    maxPagesPerRepair: z.number().int().min(1).max(50).default(8),
  })
  .strict();

export type RepairEvaluationPolicy = z.infer<typeof RepairEvaluationPolicySchema>;

/**
 * Host evaluation / repair budgets and behaviour for candidate rounds.
 * Derived from WikiRunSpec acceptance via {@link evaluationPolicyFromAcceptance}.
 */
export const EvaluationPolicySchema = z
  .object({
    maxCandidates: z.number().int().min(1).max(16).default(4),
    mechanical: MechanicalEvaluationPolicySchema.default(() =>
      MechanicalEvaluationPolicySchema.parse({}),
    ),
    semantic: SemanticEvaluationPolicySchema.default(() => SemanticEvaluationPolicySchema.parse({})),
    repair: RepairEvaluationPolicySchema.default(() => RepairEvaluationPolicySchema.parse({})),
    onExhausted: EvaluationOnExhaustedSchema.default("fail"),
  })
  .strict();

export type EvaluationPolicy = z.infer<typeof EvaluationPolicySchema>;

/**
 * Optional acceptance-side policy overrides (backward-compatible; all optional).
 * Nested under WikiRunSpec.acceptance when operators want richer control without
 * a full EvaluationPolicy document.
 */
export const EvaluationPolicyOverridesSchema = z
  .object({
    maxCandidates: z.number().int().min(1).max(16).optional(),
    mechanical: MechanicalEvaluationPolicySchema.partial()
      .extend({
        autoFix: MechanicalAutoFixPolicySchema.partial().optional(),
      })
      .strict()
      .optional(),
    semantic: SemanticEvaluationPolicySchema.partial().strict().optional(),
    repair: RepairEvaluationPolicySchema.partial().strict().optional(),
    onExhausted: EvaluationOnExhaustedSchema.optional(),
  })
  .strict();

export type EvaluationPolicyOverrides = z.infer<typeof EvaluationPolicyOverridesSchema>;

/**
 * Map WikiRunSpec acceptance budgets into a full EvaluationPolicy.
 * - maxRepairRounds → semantic.modelRepairBudget
 * - maxHardValidateRepairRounds → mechanical.modelRepairBudget
 * - reviewRequired / blockingSeverities from acceptance
 * - maxCandidates / evaluationPolicy overrides when present on acceptance
 * - remaining fields use EvaluationPolicy defaults
 */
export function evaluationPolicyFromAcceptance(
  acceptance: WikiRunSpecAcceptance,
): EvaluationPolicy {
  const base = EvaluationPolicySchema.parse({
    mechanical: {
      modelRepairBudget: acceptance.maxHardValidateRepairRounds,
    },
    semantic: {
      reviewRequired: acceptance.reviewRequired,
      modelRepairBudget: acceptance.maxRepairRounds,
      blockingSeverities: acceptance.blockingSeverities,
    },
  });

  const maxCandidates =
    typeof acceptance.maxCandidates === "number" ? acceptance.maxCandidates : undefined;
  const overrides = acceptance.evaluationPolicy;

  if (maxCandidates === undefined && overrides === undefined) {
    return base;
  }

  const mergedMechanical = overrides?.mechanical
    ? {
        ...base.mechanical,
        ...overrides.mechanical,
        autoFix: {
          ...base.mechanical.autoFix,
          ...(overrides.mechanical.autoFix ?? {}),
        },
      }
    : base.mechanical;

  const mergedSemantic = overrides?.semantic
    ? { ...base.semantic, ...overrides.semantic }
    : base.semantic;

  const mergedRepair = overrides?.repair ? { ...base.repair, ...overrides.repair } : base.repair;

  return EvaluationPolicySchema.parse({
    maxCandidates: overrides?.maxCandidates ?? maxCandidates ?? base.maxCandidates,
    mechanical: mergedMechanical,
    semantic: mergedSemantic,
    repair: mergedRepair,
    onExhausted: overrides?.onExhausted ?? base.onExhausted,
  });
}
