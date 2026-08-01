import { z } from "zod";
import { RepairRequestSchema } from "./evaluation.js";
import { Sha256HexSchema } from "./primitives.js";
import {
  AttemptMetricsSchema,
  RunAttemptIdSchema,
  RunNodeKeySchema,
  WikiRunArtifactKindSchema,
  WikiRunArtifactSchema,
  WikiRunIdSchema,
  WikiRunNodeKindSchema,
} from "./wiki-runs.js";
import { SourceIdSchema, WorkspaceConfigSchema } from "./workspace.js";

const MAX_PATH_LENGTH = 4_096;
const LogicalRoleSchema = z.string().trim().min(1).max(100);
const BoundedTextSchema = z.string().trim().min(1).max(4_000);
const AbsoluteLocalPathPattern = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** Local filesystem path valid as absolute on either supported host platform. */
export const LocalAbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => !value.includes("\0") && AbsoluteLocalPathPattern.test(value), {
    message: "expected an absolute local path",
  });

export type LocalAbsolutePath = z.infer<typeof LocalAbsolutePathSchema>;

/** A sealed immutable Artifact made locally available to one Attempt. */
export const PiAttemptInputArtifactSchema = z
  .object({
    role: LogicalRoleSchema,
    artifact: WikiRunArtifactSchema,
    readOnlyPath: LocalAbsolutePathSchema,
  })
  .strict();

export type PiAttemptInputArtifact = z.infer<typeof PiAttemptInputArtifactSchema>;

/**
 * Secret-free node detail for prompt construction (from nodes.detail_json).
 * Carries definition fields (question, lens, …) plus optional operator feedback.
 * Never carries provider secrets or full Spec bodies.
 */
export const PiAttemptNodeDetailSchema = z
  .object({
    domainId: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().max(500).optional(),
    scope: z.string().trim().max(2_000).optional(),
    question: z.string().trim().max(4_000).optional(),
    questionIndex: z.number().int().positive().optional(),
    questions: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    lens: z.string().trim().min(1).max(100).optional(),
    /** Council seat index for reviewer roleModels.reviewers[i] rotation. */
    seatIndex: z.number().int().min(0).max(16).optional(),
    critical: z.boolean().optional(),
    workUnitId: z.string().trim().min(1).max(120).optional(),
    adaptRound: z.number().int().min(1).max(2).optional(),
    feedback: z.string().trim().min(1).max(4_000).optional(),
    /**
     * Structured repair envelope from scheduleMechanicalRepair / scheduleOperatorRepair.
     * Optional so older detail_json rows still parse; agents may ignore when absent.
     */
    repairRequest: RepairRequestSchema.optional(),
  })
  .strict();

export type PiAttemptNodeDetail = z.infer<typeof PiAttemptNodeDetailSchema>;

export const PiAttemptNodeSchema = z
  .object({
    key: RunNodeKeySchema,
    kind: WikiRunNodeKindSchema,
    generation: z.number().int().min(0),
    runIndex: z.number().int().positive(),
    /** Sealed definition / operator detail for this generation (optional). */
    detail: PiAttemptNodeDetailSchema.optional(),
  })
  .strict();

export type PiAttemptNode = z.infer<typeof PiAttemptNodeSchema>;

/** Serializable, secret-free handoff from the WikiRuns owner to a Pi Attempt. */
export const PiAttemptInputSchema = z
  .object({
    runId: WikiRunIdSchema,
    attemptId: RunAttemptIdSchema,
    node: PiAttemptNodeSchema,
    inputDigest: Sha256HexSchema,
    /** Immutable, safe-boundary-applied Run guidance visible to this fresh Attempt. */
    revisions: z
      .array(
        z
          .object({
            revisionId: z.string().trim().min(1),
            kind: z.enum(["guidance", "scope_change"]),
            content: z.string().trim().min(1).max(8_000),
          })
          .strict(),
      )
      .optional(),
    workspace: WorkspaceConfigSchema.strict(),
    sealedInputs: z.array(PiAttemptInputArtifactSchema).min(1).max(64),
    attemptDir: LocalAbsolutePathSchema,
    workDir: LocalAbsolutePathSchema,
    sessionPath: LocalAbsolutePathSchema,
    skillPath: LocalAbsolutePathSchema,
    sourcePaths: z.record(SourceIdSchema, LocalAbsolutePathSchema),
  })
  .strict()
  .superRefine((input, ctx) => {
    const roles = new Set<string>();
    for (const [index, artifact] of input.sealedInputs.entries()) {
      if (roles.has(artifact.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "sealed input roles must be unique",
          path: ["sealedInputs", index, "role"],
        });
      }
      roles.add(artifact.role);
    }
  });

export type PiAttemptInput = z.infer<typeof PiAttemptInputSchema>;

/** An Attempt-owned path that WikiRuns may validate, seal, and then commit. */
export const PiAttemptArtifactDescriptorSchema = z
  .object({
    kind: WikiRunArtifactKindSchema,
    role: LogicalRoleSchema,
    sourcePath: LocalAbsolutePathSchema,
    directory: z.boolean(),
    summary: BoundedTextSchema.optional(),
  })
  .strict();

export type PiAttemptArtifactDescriptor = z.infer<typeof PiAttemptArtifactDescriptorSchema>;

export const PiAttemptTranscriptDescriptorSchema = PiAttemptArtifactDescriptorSchema.extend({
  kind: z.literal("transcript"),
  directory: z.literal(false),
});

export type PiAttemptTranscriptDescriptor = z.infer<typeof PiAttemptTranscriptDescriptorSchema>;

export const PiAttemptFailureClassSchema = z.enum([
  "provider",
  "capacity",
  "budget",
  "infrastructure",
  "cancelled",
  /** Publication CAS rejected a stale baseline; operator must rebase or abandon. */
  "publication_conflict",
  /** Mechanical / product quality defects (e.g. hard-validate dirty wiki). */
  "schema",
]);

export type PiAttemptFailureClass = z.infer<typeof PiAttemptFailureClassSchema>;

/**
 * Optional observation metrics on a terminal Attempt outcome.
 * Missing fields never block completion; WikiRuns fills wall_time/role when known.
 */
const PiAttemptOutcomeMetricsField = {
  metrics: AttemptMetricsSchema.optional(),
} as const;

/** Terminal result from one discardable Pi Attempt. */
export const PiAttemptOutcomeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("succeeded"),
      unsealedArtifacts: z.array(PiAttemptArtifactDescriptorSchema).min(1).max(64),
      summary: BoundedTextSchema.optional(),
      ...PiAttemptOutcomeMetricsField,
    })
    .strict(),
  z
    .object({
      type: z.literal("gate_requested"),
      question: z.string().trim().min(1).max(1_000),
      context: BoundedTextSchema.optional(),
      transcript: PiAttemptTranscriptDescriptorSchema,
      ...PiAttemptOutcomeMetricsField,
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      error: BoundedTextSchema,
      failureClass: PiAttemptFailureClassSchema,
      /**
       * Failure evidence that must be sealed before the Attempt becomes
       * terminal. Validation uses this for its complete MechanicalReport.
       */
      unsealedArtifacts: z.array(PiAttemptArtifactDescriptorSchema).min(1).max(64).optional(),
      ...PiAttemptOutcomeMetricsField,
    })
    .strict(),
]);

export type PiAttemptOutcome = z.infer<typeof PiAttemptOutcomeSchema>;

/**
 * Runtime injection slot: WikiRuns calls this for Pi-backed nodes.
 * Defined on the contract so agent (implements) and workflow (owns control)
 * share one type without a forbidden agent→workflow dependency.
 */
export type PiAttemptExecutor = (
  input: PiAttemptInput,
  signal: AbortSignal,
) => Promise<PiAttemptOutcome>;
