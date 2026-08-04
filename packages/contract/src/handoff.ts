/**
 * File-authority handoff envelope (control return).
 *
 * Doctrine (ADR 0011 / 0042): the **file on disk is authority**. Control-plane
 * returns and model context carry only a short {@link HandoffEnvelope}
 * (summary, status, open questions, evidence refs). Large bodies (DiscoveryMap,
 * Spec, receipts, wiki trees) live under the Run Boundary and are never the
 * primary message payload.
 *
 * {@link AnalysisReceipt} remains the research/review receipt schema and stays
 * compatible. HandoffEnvelope is the cross-node control summary used when a
 * node finishes and the next stage only needs a bounded pointer + status.
 */

import { z } from "zod";
import { AnalysisReceiptSchema, ReceiptEvidenceSchema, ReceiptStatusSchema } from "./receipt.js";

const SUMMARY_MAX = 800;
const QUESTION_MAX = 500;
const ID_MAX = 200;

/**
 * Bounded control handoff. Prefer mounting the full artifact; put only a short
 * summary and ids here. `payload` is optional and must stay small if used.
 */
export const HandoffEnvelopeSchema = z
  .object({
    version: z.literal(1).default(1),
    runId: z.string().trim().min(1).max(ID_MAX),
    nodeKey: z.string().trim().min(1).max(ID_MAX),
    /** Logical producer role (plan_scout, plan_discover, leaf, …). */
    role: z.string().trim().min(1).max(64),
    status: ReceiptStatusSchema,
    /** When true, failure of this handoff is a hard plan/run gap. */
    critical: z.boolean().default(false),
    /** Short control summary — not the full artifact body. */
    summary: z.string().max(SUMMARY_MAX).default(""),
    openQuestions: z.array(z.string().trim().min(1).max(QUESTION_MAX)).max(32).default([]),
    coverageUnitIds: z.array(z.string().trim().min(1).max(400)).max(64).optional(),
    discoveryCandidateIds: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
    evidence: z.array(ReceiptEvidenceSchema).max(32).default([]),
    /**
     * Optional tiny structured extras (paths, digests, counts). Never place a
     * full Spec / DiscoveryMap / wiki tree here — file is authority.
     */
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type HandoffEnvelope = z.infer<typeof HandoffEnvelopeSchema>;

/** Parse a handoff envelope; returns undefined when shape is not recognized. */
export function parseHandoffEnvelope(raw: unknown): HandoffEnvelope | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.runId !== "string" || typeof obj.nodeKey !== "string") return undefined;
  const parsed = HandoffEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Project a research {@link AnalysisReceipt} into a control {@link HandoffEnvelope}.
 * Does not copy findings/body — only status, summary, open questions, evidence.
 * File path of the full receipt remains the authority for body content.
 */
export function handoffFromAnalysisReceipt(
  receipt: z.infer<typeof AnalysisReceiptSchema>,
  opts: {
    nodeKey: string;
    role: string;
    critical?: boolean;
    coverageUnitIds?: readonly string[];
    discoveryCandidateIds?: readonly string[];
    payload?: Record<string, unknown>;
  },
): HandoffEnvelope {
  const summary =
    receipt.summary.length <= SUMMARY_MAX
      ? receipt.summary
      : receipt.summary.slice(0, SUMMARY_MAX - 1) + "…";
  return HandoffEnvelopeSchema.parse({
    version: 1,
    runId: receipt.runId,
    nodeKey: opts.nodeKey,
    role: opts.role,
    status: receipt.status,
    critical: opts.critical === true,
    summary,
    openQuestions: receipt.openQuestions.slice(0, 32),
    ...(opts.coverageUnitIds
      ? { coverageUnitIds: [...opts.coverageUnitIds] }
      : {}),
    ...(opts.discoveryCandidateIds
      ? { discoveryCandidateIds: [...opts.discoveryCandidateIds] }
      : {}),
    evidence: receipt.evidence.slice(0, 32),
    ...(opts.payload ? { payload: opts.payload } : {}),
  });
}

