import { z } from "zod";
import { GitObjectIdSchema } from "./primitives.js";
import { DEFAULT_ORCHESTRATION, IgnorePatternSchema, SourceIdSchema } from "./workspace.js";

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
 * Optional `maxCandidates` and `evaluationPolicy` tune the bounded policy
 * that the runtime actually enforces.
 */
export const WikiRunSpecAcceptanceSchema = z.object({
  reviewRequired: z.boolean().default(true),
  /** Council review repair budget only (blocking defects from review seats). */
  maxRepairRounds: z.number().int().min(0).max(8).default(2),
  /** Automatically consume the bounded repair budgets before opening a fix gate. */
  autoRepair: z.boolean().default(true),
  /**
   * Mechanical hard-validate *model* repair budget only (missing critical pages,
   * non-autoFixable citation defects, …). Independent of `maxRepairRounds`.
   * Default 1: host citation autofix runs first, then one bounded model repair
   * is available for defects that need generated content changes.
   */
  maxHardValidateRepairRounds: z.number().int().min(0).max(8).default(1),
  /** Severities that block publish when present after final review. */
  blockingSeverities: z.array(z.enum(["blocking", "major", "minor"])).default(["blocking"]),
  /** Cap on WikiCandidate versions in one run (EvaluationPolicy.maxCandidates). */
  maxCandidates: z.number().int().min(1).max(16).optional(),
  /**
   * Optional nested EvaluationPolicy overrides (partial). The shape mirrors
   * only runtime-enforced controls to avoid offering inert configuration.
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
          blockingSeverities: z.array(z.enum(["blocking", "major", "minor"])).optional(),
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
 * Topology fan-out caps shared by host `compileExecutionPlan` and the planner
 * `submit_wiki_run_spec` tool. Fail-closed — never silent truncation.
 */
export type SpecFanOutCaps = {
  maxDomainFanOut?: number;
  maxLeafFanOut?: number;
};

/** Clamp fan-out caps to the same 1..16 range used by host compile. */
export function resolveSpecFanOutCaps(caps?: SpecFanOutCaps): {
  maxDomainFanOut: number;
  maxLeafFanOut: number;
} {
  return {
    maxDomainFanOut: Math.max(
      1,
      Math.min(16, Math.floor(caps?.maxDomainFanOut ?? DEFAULT_ORCHESTRATION.maxDomainFanOut)),
    ),
    maxLeafFanOut: Math.max(
      1,
      Math.min(16, Math.floor(caps?.maxLeafFanOut ?? DEFAULT_ORCHESTRATION.maxLeafFanOut)),
    ),
  };
}

export class SpecFanOutCapError extends Error {
  readonly code = "SPEC_FAN_OUT_CAP";

  constructor(message: string) {
    super(message);
    this.name = "SpecFanOutCapError";
  }
}

/**
 * Assert a WikiRunSpec stays within domain / per-domain leaf fan-out caps.
 * Used by plan-compiler (host) and submit_wiki_run_spec (agent tool) so the
 * planner is rejected in-session with the same messages host compile uses.
 */
export function assertSpecWithinFanOutCaps(
  spec: Pick<WikiRunSpec, "domains">,
  caps?: SpecFanOutCaps,
): void {
  const { maxDomainFanOut, maxLeafFanOut } = resolveSpecFanOutCaps(caps);
  const domains = spec.domains ?? [];
  if (domains.length > maxDomainFanOut) {
    throw new SpecFanOutCapError(
      `WikiRunSpec has ${domains.length} domains but maxDomainFanOut is ${maxDomainFanOut}; ` +
        `reduce domains in the Spec or raise workspace.orchestration.maxDomainFanOut ` +
        `(silent truncation is not allowed)`,
    );
  }
  for (const domain of domains) {
    const domainId = domain.id.trim();
    const questions = (domain.questions ?? []).map((q) => q.trim()).filter((q) => q.length > 0);
    if (questions.length > maxLeafFanOut) {
      throw new SpecFanOutCapError(
        `Domain "${domainId}" has ${questions.length} questions but maxLeafFanOut is ${maxLeafFanOut}; ` +
          `reduce questions or raise workspace.orchestration.maxLeafFanOut ` +
          `(silent truncation is not allowed)`,
      );
    }
  }
}

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
  })
  .strict();

export type ExecutionPlanWorkUnit = z.infer<typeof ExecutionPlanWorkUnitSchema>;

/** A bounded research gap found after the initial plan's evidence has landed. */
export const ExecutionPlanDeltaWorkUnitSchema = z
  .object({
    /** Stable planner-supplied id, unique for the lifetime of this Run. */
    id: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    domainId: z.string().trim().min(1).max(80),
    question: z.string().trim().min(1).max(500),
    scope: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type ExecutionPlanDeltaWorkUnit = z.infer<typeof ExecutionPlanDeltaWorkUnitSchema>;

/**
 * A proposal, never an editable graph: WikiRuns validates and materializes
 * research nodes/edges from it under the frozen plan caps.
 */
export const ExecutionPlanDeltaSchema = z
  .object({
    version: z.literal(1),
    complete: z.boolean(),
    additions: z.array(ExecutionPlanDeltaWorkUnitSchema).max(16),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((delta, ctx) => {
    if (!delta.complete && delta.additions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an incomplete adaptation must add at least one research work unit",
        path: ["additions"],
      });
    }
    const ids = new Set<string>();
    for (const [index, addition] of delta.additions.entries()) {
      if (ids.has(addition.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate adaptation work unit id: ${addition.id}`,
          path: ["additions", index, "id"],
        });
      }
      ids.add(addition.id);
    }
  });

export type ExecutionPlanDelta = z.infer<typeof ExecutionPlanDeltaSchema>;

export const ExecutionPlanSchema = z
  .object({
    version: z.literal(4),
    workUnits: z.array(ExecutionPlanWorkUnitSchema),
    /**
     * Review council lenses. Empty only when Spec acceptance.reviewRequired is false
     * (compile may emit zero seats). When reviewRequired, host requires ≥1 seat.
     */
    reviewLenses: z.array(z.string().trim().min(1).max(100)).max(4),
    fanOut: z
      .object({
        domainCount: z.number().int().min(0),
        leafCount: z.number().int().min(0),
        maxDomainFanOut: z.number().int().min(1).max(16),
        maxLeafFanOut: z.number().int().min(1).max(16),
      })
      .strict(),
    /** Evidence-gap adaptation is explicit; simple plans have no adapt node. */
    adaptation: z
      .object({
        required: z.boolean(),
        maxRounds: z.number().int().min(0).max(2),
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
      maxHardValidateRepairRounds: 1,
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
