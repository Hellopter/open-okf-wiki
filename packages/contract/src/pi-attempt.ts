import { z } from "zod";
import { Sha256HexSchema } from "./primitives.js";
import {
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

export const PiAttemptNodeSchema = z
  .object({
    key: RunNodeKeySchema,
    kind: WikiRunNodeKindSchema,
    generation: z.number().int().min(0),
    runIndex: z.number().int().positive(),
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
]);

export type PiAttemptFailureClass = z.infer<typeof PiAttemptFailureClassSchema>;

/** Terminal result from one discardable Pi Attempt. */
export const PiAttemptOutcomeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("succeeded"),
      unsealedArtifacts: z.array(PiAttemptArtifactDescriptorSchema).min(1).max(64),
      summary: BoundedTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("gate_requested"),
      question: z.string().trim().min(1).max(1_000),
      context: BoundedTextSchema.optional(),
      transcript: PiAttemptTranscriptDescriptorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      error: BoundedTextSchema,
      failureClass: PiAttemptFailureClassSchema,
    })
    .strict(),
]);

export type PiAttemptOutcome = z.infer<typeof PiAttemptOutcomeSchema>;
