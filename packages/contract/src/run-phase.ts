import { z } from "zod";

/**
 * wiki_produce tool details status.
 *
 * Product writes only receipt values: `accepted` | `failed` | `cancelled`
 * (ADR 0035: StartRun dispatch, not whole-Run ownership).
 *
 * Historical JSONL may still carry pre-0035 phase strings; those are read-only
 * compatibility values and are never written by the current tool path.
 */
export const WikiProduceToolStatusSchema = z.enum([
  "accepted",
  "failed",
  "cancelled",
  // Historical toolResult rows only (pre–StartRun-receipt cut):
  "freezing",
  "planning",
  "awaiting_plan",
  "producing",
  "awaiting_publication",
  "published",
  "publication_declined",
]);
export type WikiProduceToolStatus = z.infer<typeof WikiProduceToolStatusSchema>;

/** Statuses the current wiki_produce tool is allowed to write. */
export const WIKI_PRODUCE_RECEIPT_STATUSES = ["accepted", "failed", "cancelled"] as const;
export type WikiProduceReceiptStatus = (typeof WIKI_PRODUCE_RECEIPT_STATUSES)[number];
