import { z } from "zod";
import { GitObjectIdSchema, Sha256HexSchema } from "./primitives.js";
import { type WikiRunRecordStatus, WikiRunRecordStatusSchema } from "./run-phase.js";
import { IgnorePatternSchema, SourceIdSchema } from "./workspace.js";

export type { WikiRunRecordStatus };
export { WikiRunRecordStatusSchema };

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

export const WikiRunSpecAcceptanceSchema = z.object({
  reviewRequired: z.boolean().default(true),
  maxRepairRounds: z.number().int().min(0).max(8).default(2),
  /** Severities that block publish when present after final review. */
  blockingSeverities: z.array(z.enum(["blocking", "major", "minor"])).default(["blocking"]),
});

export type WikiRunSpecAcceptance = z.infer<typeof WikiRunSpecAcceptanceSchema>;

/**
 * Living, executable Wiki Run specification (operator-facing + agent-facing).
 * Replaces the thin path/purpose plan: domains, questions, acceptance, replan trail.
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

export const DefectReportSchema = z.object({
  version: z.literal(1).default(1),
  reviewerId: z.string().min(1),
  clean: z.boolean(),
  defects: z.array(DefectItemSchema).default([]),
  summary: z.string().max(2000).optional(),
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

/**
 * Complete, secret-free Wiki Run Record.
 *
 * Every key is present in v2. State-dependent outcome fields use null/empty
 * values so readers never infer semantics from a missing property. Frozen
 * inputs are immutable after creation; only status and result fields change.
 */
export const StoredRunRecordSchema = z
  .object({
    schema: z.literal("okf.wiki-run/v2"),
    runId: z.string().trim().min(1),
    workspaceId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    status: WikiRunRecordStatusSchema,
    autoApprove: z.boolean(),
    error: z.string().nullable(),
    /** Absolute path to the immutable, run-owned Producer Skill copy. */
    skillPath: z.string().trim().min(1),
    /** SHA-256 content digest reverified after copying the Producer Skill. */
    skillDigest: Sha256HexSchema,
    sources: z.array(RepositorySnapshotSchema).min(1),
    spec: WikiRunSpecSchema.nullable(),
    /** Wiki-relative page paths produced under staging. */
    pages: z.array(z.string().trim().min(1)),
    /** Short operator-facing outcome summary. */
    summary: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type StoredRunRecord = z.infer<typeof StoredRunRecordSchema>;

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
