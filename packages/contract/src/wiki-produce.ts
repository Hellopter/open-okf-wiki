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
  })
  .strict();

export type WikiProduceToolDetails = z.infer<typeof WikiProduceToolDetailsSchema>;
