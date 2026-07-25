import { z } from "zod";
import { GitObjectIdSchema, Sha256HexSchema } from "./primitives.js";

export const ReceiptStatusSchema = z.enum(["complete", "partial", "failed", "cancelled"]);

export const ReceiptEvidenceSchema = z
  .object({
    repositoryId: z.string().min(1),
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    contentSha256: Sha256HexSchema.optional(),
  })
  .superRefine((ev, ctx) => {
    if (ev.startLine !== undefined && ev.endLine !== undefined && ev.startLine > ev.endLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "startLine must be <= endLine",
        path: ["startLine"],
      });
    }
  });

/**
 * Bounded analysis receipt (control plane returns a short handoff; body on disk).
 * Cap enforcement is core's job; schema only describes shape.
 */
export const AnalysisReceiptSchema = z.object({
  version: z.literal(1).default(1),
  runId: z.string(),
  nodeId: z.string(),
  parentId: z.string().nullable(),
  attempt: z.number().int().positive(),
  status: ReceiptStatusSchema,
  scope: z.string(),
  sourceRevision: GitObjectIdSchema.nullable().optional(),
  summary: z.string().default(""),
  findings: z.array(z.string()).default([]),
  evidence: z.array(ReceiptEvidenceSchema).default([]),
  childReceipts: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type AnalysisReceipt = z.infer<typeof AnalysisReceiptSchema>;
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;
