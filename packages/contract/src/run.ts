import { z } from "zod";
import { GitObjectIdSchema } from "./primitives.js";
import { IgnorePatternSchema, SourceIdSchema } from "./workspace.js";

/** Page template hints from the Producer Skill. */
export const WikiPageTemplateSchema = z.enum([
  "overview",
  "architecture",
  "module",
  "flow",
  "concept",
]);

export type WikiPageTemplate = z.infer<typeof WikiPageTemplateSchema>;

export const WikiRunSpecDomainSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  /** Source scope description (paths, boundaries, concerns). */
  scope: z.string().trim().min(1).max(2000),
  critical: z.boolean().default(true),
  questions: z.array(z.string().trim().min(1).max(500)).default([]),
});

export type WikiRunSpecDomain = z.infer<typeof WikiRunSpecDomainSchema>;

export const WikiRunSpecPageSchema = z.object({
  path: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  domainIds: z.array(z.string().trim().min(1)).default([]),
  questions: z.array(z.string().trim().min(1).max(500)).default([]),
  template: WikiPageTemplateSchema.optional(),
  critical: z.boolean().default(true),
});

export type WikiRunSpecPage = z.infer<typeof WikiRunSpecPageSchema>;

/**
 * Acceptance knobs on WikiSpec. Budgets map into EvaluationPolicy via
 * `evaluationPolicyFromAcceptance` (contract/evaluation).
 *
 * Optional `maxCandidates` and `evaluationPolicy` are backward-compatible
 * overrides; omitted fields keep EvaluationPolicy defaults.
 */
export const WikiRunSpecAcceptanceSchema = z.object({
  reviewRequired: z.boolean().default(true),
  /** Council review repair budget only (blocking defects from review seats). */
  maxRepairRounds: z.number().int().min(0).max(8).default(2),
  /**
   * Mechanical hard-validate *model* repair budget only (missing critical pages,
   * non-autoFixable citation defects, …). Independent of `maxRepairRounds`.
   * Default 0: host citation autofix (clamp/canonicalize) is preferred; raise
   * only when model repair of mechanical defects is required.
   */
  maxHardValidateRepairRounds: z.number().int().min(0).max(8).default(0),
  /** Severities that block publish when present after final review. */
  blockingSeverities: z.array(z.enum(["blocking", "major", "minor"])).default(["blocking"]),
  /** Cap on WikiCandidate versions in one run (EvaluationPolicy.maxCandidates). */
  maxCandidates: z.number().int().min(1).max(16).optional(),
  /**
   * Optional nested EvaluationPolicy overrides (partial).
   * Shape is intentionally loose here to avoid a run↔evaluation import cycle;
   * `evaluationPolicyFromAcceptance` validates/merges against EvaluationPolicySchema.
   */
  evaluationPolicy: z
    .object({
      maxCandidates: z.number().int().min(1).max(16).optional(),
      mechanical: z
        .object({
          requireCitations: z.boolean().optional(),
          requireCriticalPages: z.boolean().optional(),
          autoFix: z
            .object({
              canonicalizeCitations: z.boolean().optional(),
              clampCitationLines: z.boolean().optional(),
              clampLineSlack: z.number().int().min(0).max(5).optional(),
              regenerateIndexes: z.boolean().optional(),
            })
            .strict()
            .optional(),
          modelRepairBudget: z.number().int().min(0).max(8).optional(),
        })
        .strict()
        .optional(),
      semantic: z
        .object({
          reviewRequired: z.boolean().optional(),
          modelRepairBudget: z.number().int().min(0).max(8).optional(),
          reReview: z.enum(["always", "affected_lenses"]).optional(),
          stickyPriorBlocking: z.boolean().optional(),
          blockingSeverities: z.array(z.enum(["blocking", "major", "minor"])).optional(),
        })
        .strict()
        .optional(),
      repair: z
        .object({
          defaultMode: z.enum(["mechanical_only", "patch", "rewrite_scoped"]).optional(),
          allowFullTreeRewrite: z.boolean().optional(),
          maxPagesPerRepair: z.number().int().min(1).max(50).optional(),
        })
        .strict()
        .optional(),
      onExhausted: z.enum(["fail", "operator"]).optional(),
    })
    .strict()
    .optional(),
});

export type WikiRunSpecAcceptance = z.infer<typeof WikiRunSpecAcceptanceSchema>;

/**
 * Content / acceptance Spec produced by the planner (WikiSpec semantically).
 * Topology fan-out is **not** derived by silent truncation here — the host
 * compiles a separate {@link ExecutionPlan} via `compileExecutionPlan`.
 * Export name stays `WikiRunSpec` for compatibility; prefer `WikiSpec` in new code.
 */
export const WikiRunSpecSchema = z
  .object({
    version: z.literal(1).default(1),
    summary: z.string().min(1).max(4000),
    audience: z
      .string()
      .min(1)
      .max(1000)
      .default("Engineers and operators reading this repository"),
    domains: z.array(WikiRunSpecDomainSchema).default([]),
    pages: z.array(WikiRunSpecPageSchema).min(1),
    openQuestions: z.array(z.string().max(500)).default([]),
    acceptance: WikiRunSpecAcceptanceSchema.default(() => WikiRunSpecAcceptanceSchema.parse({})),
    /** Operator revision feedback and agent replan notes. */
    notes: z.string().max(4000).optional(),
    /** Chronological replan / discovery trail (stigmergy-lite). */
    changelog: z.array(z.string().max(500)).default([]),
  })
  .superRefine((spec, ctx) => {
    const domainIds = new Set(spec.domains.map((d) => d.id));
    const referencedDomainIds = new Set<string>();

    for (let i = 0; i < spec.pages.length; i++) {
      const page = spec.pages[i];
      if (spec.domains.length > 0 && page.domainIds.length < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "page must reference at least one domain when domains are non-empty",
          path: ["pages", i, "domainIds"],
        });
      }
      for (const domainId of page.domainIds) {
        referencedDomainIds.add(domainId);
        if (!domainIds.has(domainId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `page domainId "${domainId}" is not in domains`,
            path: ["pages", i, "domainIds"],
          });
        }
      }
    }

    if (spec.domains.length > 0) {
      for (let i = 0; i < spec.domains.length; i++) {
        const domain = spec.domains[i]!;
        if (!referencedDomainIds.has(domain.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `domain "${domain.id}" is not referenced by any page`,
            path: ["domains", i, "id"],
          });
        }
      }
    }
  });

export type WikiRunSpec = z.infer<typeof WikiRunSpecSchema>;

/** Semantic alias: content Spec only (not host ExecutionPlan). */
export const WikiSpecSchema = WikiRunSpecSchema;
export type WikiSpec = WikiRunSpec;

/**
 * Host-compiled execution topology (not planner product output).
 * Built by `compileExecutionPlan(spec, caps)`; sealed as artifact kind `execution_plan`.
 * Hard-cut: over-cap Spec fails compile — never silent `.slice` truncation.
 */
export const ExecutionPlanWorkUnitSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    domainId: z.string().trim().min(1).max(80).optional(),
    questions: z.array(z.string().trim().min(1).max(500)).default([]),
    scope: z.string().trim().min(1).max(2_000),
    kind: z.enum(["leaf", "cluster"]),
  })
  .strict();

export type ExecutionPlanWorkUnit = z.infer<typeof ExecutionPlanWorkUnitSchema>;

export const ExecutionPlanReductionSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    childWorkUnitIds: z.array(z.string().trim().min(1).max(200)).min(1),
    domainId: z.string().trim().min(1).max(80),
  })
  .strict();

export type ExecutionPlanReduction = z.infer<typeof ExecutionPlanReductionSchema>;

export const ExecutionPlanSchema = z
  .object({
    version: z.literal(2),
    workUnits: z.array(ExecutionPlanWorkUnitSchema),
    reductions: z.array(ExecutionPlanReductionSchema),
    /**
     * Review council lenses. Empty only when Spec acceptance.reviewRequired is false
     * (compile may emit zero seats). When reviewRequired, host requires ≥1 seat.
     */
    reviewLenses: z.array(z.string().trim().min(1).max(100)).max(4),
    budgets: z
      .object({
        maxRepairRounds: z.number().int().min(0).max(8),
        maxHardValidateRepairRounds: z.number().int().min(0).max(8),
      })
      .strict(),
    roleModels: z.record(z.string(), z.unknown()).optional(),
    fanOut: z
      .object({
        domainCount: z.number().int().min(0),
        leafCount: z.number().int().min(0),
        maxDomainFanOut: z.number().int().min(1).max(16),
        maxLeafFanOut: z.number().int().min(1).max(16),
      })
      .strict(),
    /** Optional link back to the Spec digest that produced this plan. */
    specDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .strict();

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

/**
 * Freeze-sealed run identity: intent + pinned inputs summary.
 * Written under freeze attempt work as `frozen-run-manifest.json`.
 */
export const FrozenRunManifestSchema = z
  .object({
    version: z.literal(2),
    /** Full StartRun intent (mode mirrored at top-level for quick reads). */
    intent: z
      .object({
        focus: z.string().trim().min(1).max(4_000).optional(),
        mode: z.enum(["generate", "refresh"]),
        objective: z.string().trim().min(1).max(4_000).optional(),
        constraints: z.string().trim().min(1).max(4_000).optional(),
        audience: z.string().trim().min(1).max(1_000).optional(),
      })
      .strict(),
    mode: z.enum(["generate", "refresh"]),
    /** SHA-256 of canonical intent JSON (deterministic). */
    intentDigest: z.string().regex(/^[a-f0-9]{64}$/i),
    skillDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    sources: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          revision: z.string().trim().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type FrozenRunManifest = z.infer<typeof FrozenRunManifestSchema>;

export const DefectSeveritySchema = z.enum(["blocking", "major", "minor"]);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const DefectItemSchema = z.object({
  severity: DefectSeveritySchema,
  code: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1).max(200).optional(),
  issue: z.string().trim().min(1).max(2000),
  suggestedFix: z.string().trim().max(2000).optional(),
  /** Reviewer that reported this item (required after merge for provenance). */
  reviewerId: z.string().trim().min(1).optional(),
});

export type DefectItem = z.infer<typeof DefectItemSchema>;

export const DefectReportSchema = z
  .object({
    version: z.literal(1).default(1),
    reviewerId: z.string().min(1),
    clean: z.boolean(),
    defects: z.array(DefectItemSchema).default([]),
    summary: z.string().max(2000).optional(),
  })
  .superRefine((report, ctx) => {
    if (report.clean && report.defects.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clean requires empty defects",
        path: ["clean"],
      });
    }
    if (!report.clean && report.defects.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-clean requires at least one defect",
        path: ["defects"],
      });
    }
  });

export type DefectReport = z.infer<typeof DefectReportSchema>;

export const MergedDefectReportSchema = z
  .object({
    version: z.literal(1).default(1),
    clean: z.boolean(),
    defects: z.array(DefectItemSchema).default([]),
    reviewerIds: z.array(z.string()).default([]),
    summary: z.string().max(4000).optional(),
  })
  .superRefine((report, ctx) => {
    if (report.clean && report.defects.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clean requires empty defects",
        path: ["clean"],
      });
    }
    if (!report.clean && report.defects.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-clean requires at least one defect",
        path: ["defects"],
      });
    }
    const reviewerIdSet = new Set(report.reviewerIds);
    for (let i = 0; i < report.defects.length; i++) {
      const defect = report.defects[i]!;
      if (defect.reviewerId !== undefined && !reviewerIdSet.has(defect.reviewerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `defect reviewerId "${defect.reviewerId}" is not in reviewerIds`,
          path: ["defects", i, "reviewerId"],
        });
      }
    }
  });

export type MergedDefectReport = z.infer<typeof MergedDefectReportSchema>;

/** Frozen identity and path policy for one Repository Snapshot. */
export const RepositorySnapshotSchema = z
  .object({
    id: SourceIdSchema,
    /** Exact Git object id materialised for the Wiki Run (SHA-1 or SHA-256). */
    revision: GitObjectIdSchema,
    /** Frozen patterns already applied to the materialised ordinary-file tree. */
    effectiveIgnores: z.array(IgnorePatternSchema),
  })
  .strict();

export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;

/** Minimal default Spec used when parsing fails or fixtures need a seed. */
export function defaultWikiRunSpec(workspaceName: string): WikiRunSpec {
  return WikiRunSpecSchema.parse({
    summary: `Source-grounded wiki for ${workspaceName}`,
    audience: "Engineers and operators reading this repository",
    domains: [
      {
        id: "core",
        title: "Core",
        scope: "Repository entry points, layout, and primary modules",
        critical: true,
        questions: ["What is this repository for?", "What are the main runtime boundaries?"],
      },
    ],
    pages: [
      {
        path: "overview.md",
        purpose: "Repository purpose, audience, and navigation",
        domainIds: ["core"],
        questions: ["What is this repository for?"],
        template: "overview",
        critical: true,
      },
    ],
    openQuestions: [],
    acceptance: {
      reviewRequired: true,
      maxRepairRounds: 2,
      maxHardValidateRepairRounds: 0,
      blockingSeverities: ["blocking"],
    },
    changelog: [],
  });
}

/**
 * Wire name of the planner's Spec submission tool (path-first plan handoff).
 * Single source for tools/, workflow/, and runtime/ so the constant cannot
 * drift between layers.
 */
export const SUBMIT_WIKI_RUN_SPEC_TOOL_NAME = "submit_wiki_run_spec" as const;

/**
 * Wire name of the reviewer's DefectReport submission tool (path-first seat handoff).
 * Single source for tools/ and runtime/ so the constant cannot drift.
 */
export const SUBMIT_DEFECT_REPORT_TOOL_NAME = "submit_defect_report" as const;
