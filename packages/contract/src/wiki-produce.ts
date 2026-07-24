import { z } from "zod";
import { MergedDefectReportSchema, WikiRunSpecSchema } from "./run.js";

/** States exposed by the real Pi `wiki_produce` tool. */
export const WikiProduceToolStatusSchema = z.enum([
  "freezing",
  "planning",
  "awaiting_plan",
  "producing",
  "awaiting_publication",
  "published",
  "publication_declined",
  "failed",
  "cancelled",
]);

export type WikiProduceToolStatus = z.infer<typeof WikiProduceToolStatusSchema>;

/** Bounded display item from an in-process child session (not Operator Session history). */
export const WikiProduceChildItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().max(8000),
  }),
  z.object({
    type: z.literal("toolCall"),
    name: z.string().trim().min(1).max(120),
    argsSummary: z.string().max(500).optional(),
    status: z.enum(["running", "done", "error"]).optional(),
  }),
]);

export type WikiProduceChildItem = z.infer<typeof WikiProduceChildItemSchema>;

/**
 * Projection of one plan/domain/leaf/reviewer/root child for operator UI.
 * Live-only: parent `wiki_produce` onUpdate / activeTool (ADR 0032).
 * Must not be required on durable toolResult.details written to Operator JSONL.
 */
export const WikiProduceChildSpanSchema = z.object({
  id: z.string().trim().min(1).max(200),
  role: z.enum(["plan", "domain", "leaf", "reviewer", "root_research", "root_write"]),
  status: z.enum(["running", "done", "error", "cancelled"]),
  summary: z.string().max(4000).optional(),
  items: z.array(WikiProduceChildItemSchema).max(50).optional(),
  usage: z
    .object({
      turns: z.number().int().nonnegative().optional(),
      contextTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type WikiProduceChildSpan = z.infer<typeof WikiProduceChildSpanSchema>;

/**
 * Full product details for **live** Pi tool updates (`onUpdate` / SSE activeTool).
 *
 * May carry gate `spec`, progressive `children`, and `defects` for the operator UI.
 * Pi does not append onUpdate payloads to Session JSONL — only the final toolResult.
 *
 * Job-authoritative copies of spec/pages/defects live under the Run Boundary
 * (Run Record v2, analysis/, wiki/), not in Operator Session history.
 */
export const WikiProduceToolDetailsSchema = z
  .object({
    status: WikiProduceToolStatusSchema,
    runId: z.string().trim().min(1).optional(),
    spec: WikiRunSpecSchema.optional(),
    pages: z.array(z.string().trim().min(1).max(200)).optional(),
    summary: z.string().max(4000).optional(),
    defects: MergedDefectReportSchema.nullable().optional(),
    children: z.array(WikiProduceChildSpanSchema).max(32).optional(),
  })
  .strict();

export type WikiProduceToolDetails = z.infer<typeof WikiProduceToolDetailsSchema>;

/**
 * Lean details for the **durable** final `toolResult` (Operator Session JSONL).
 *
 * Path-first control return: status + runId + short summary + optional page paths.
 * Omits live-only mirrors of Run artifacts (`spec`, `children`, `defects`).
 * Older JSONL rows may still contain those fields; readers should treat Run Record
 * as authority for job facts after the tool settles.
 */
export const WikiProduceDurableDetailsSchema = z
  .object({
    status: WikiProduceToolStatusSchema,
    runId: z.string().trim().min(1).optional(),
    pages: z.array(z.string().trim().min(1).max(200)).optional(),
    summary: z.string().max(4000).optional(),
  })
  .strict();

export type WikiProduceDurableDetails = z.infer<typeof WikiProduceDurableDetailsSchema>;

/** Project live details into the durable toolResult shape (never mutates input). */
export function toDurableWikiProduceDetails(
  details: WikiProduceToolDetails,
): WikiProduceDurableDetails {
  const summary = details.summary?.trim().slice(0, 4000);
  return WikiProduceDurableDetailsSchema.parse({
    status: details.status,
    ...(details.runId ? { runId: details.runId } : {}),
    ...(details.pages?.length ? { pages: details.pages } : {}),
    ...(summary ? { summary } : {}),
  });
}

/**
 * Read-side projection for Operator history / SSE snapshot.
 * Strips live-only fields from wiki_produce toolResult.details without mutating
 * Pi SessionManager storage. Safe on already-lean durable rows and non-wiki tools.
 */
export function projectWikiProduceDetailsForHistory(details: unknown): unknown {
  if (!details || typeof details !== "object" || Array.isArray(details)) return details;
  const row = details as Record<string, unknown>;
  if (typeof row.status !== "string") return details;
  // Only strip known live mirrors; leave unknown keys for forward compatibility
  // after validating status looks like a wiki_produce status.
  if (!WikiProduceToolStatusSchema.safeParse(row.status).success) return details;
  const { spec: _spec, children: _children, defects: _defects, ...rest } = row;
  return rest;
}
