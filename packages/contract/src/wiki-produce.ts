import { z } from "zod";
import { type WikiProduceToolStatus, WikiProduceToolStatusSchema } from "./run-phase.js";

export type { WikiProduceToolStatus };
export { WikiProduceToolStatusSchema };

/**
 * wiki_produce tool details — StartRun receipt only (ADR 0035).
 *
 * Live Run status, gates, graph, and defects live on WikiRuns (Run SSE / GET snapshot).
 * Do not reintroduce fat control mirrors (spec / graph / defects) here.
 */
export const WikiProduceToolDetailsSchema = z
  .object({
    status: WikiProduceToolStatusSchema,
    runId: z.string().trim().min(1).optional(),
    summary: z.string().max(4000).optional(),
    /**
     * Optional page paths from historical pre-receipt toolResults.
     * Current product path does not write pages on the StartRun receipt.
     */
    pages: z.array(z.string().trim().min(1).max(200)).optional(),
  })
  .strict();

export type WikiProduceToolDetails = z.infer<typeof WikiProduceToolDetailsSchema>;

/**
 * Durable final toolResult shape (Operator Session JSONL).
 * Identical to the live receipt shape after the T7 slim — kept as an alias so
 * call sites that distinguished live vs durable remain type-clear.
 */
export const WikiProduceDurableDetailsSchema = WikiProduceToolDetailsSchema;
export type WikiProduceDurableDetails = WikiProduceToolDetails;

/** Project any details object into the receipt shape (never mutates input). */
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
 * Strips legacy fat fields (spec/graph/defects/children) from pre-0035 rows
 * without mutating Pi SessionManager storage.
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
    // Tombstone: legacy pre-graph `children` only — strip old JSONL; never dual-write.
    children: _children,
    ...rest
  } = row;
  return rest;
}
