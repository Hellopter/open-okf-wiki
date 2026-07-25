import { z } from "zod";
import { MergedDefectReportSchema, WikiRunSpecSchema } from "./run.js";
import { type RunGraphSnapshot, RunGraphSnapshotSchema } from "./run-graph.js";
import { type WikiProduceToolStatus, WikiProduceToolStatusSchema } from "./run-phase.js";

export type { WikiProduceToolStatus };
export { WikiProduceToolStatusSchema };

/**
 * Full product details for **live** Pi tool updates (`onUpdate` / SSE activeTool).
 *
 * May carry gate `spec`, progressive `graph`, and `defects` for the operator UI.
 * Pi does not append onUpdate payloads to Session JSONL — only the final toolResult.
 *
 * Job-authoritative copies of spec/pages/defects/graph live under the Run Boundary
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
    /** Live Run Graph projection (topology + append-only attempts). */
    graph: RunGraphSnapshotSchema.optional(),
  })
  .strict();

export type WikiProduceToolDetails = z.infer<typeof WikiProduceToolDetailsSchema>;

/**
 * Lean details for the **durable** final `toolResult` (Operator Session JSONL).
 *
 * Path-first control return: status + runId + short summary + optional page paths.
 * Omits live-only mirrors of Run artifacts (`spec`, `graph`, `defects`).
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
  if (!WikiProduceToolStatusSchema.safeParse(row.status).success) return details;
  const {
    spec: _spec,
    graph: _graph,
    defects: _defects,
    // Legacy live mirrors (pre-Run-Graph) — strip if present on old JSONL.
    children: _children,
    ...rest
  } = row;
  return rest;
}

export type { RunGraphSnapshot };
