import { z } from "zod";

/** The only v2 wiki_produce receipt states (ADR 0035). */
export const WIKI_PRODUCE_RECEIPT_STATUSES = ["accepted", "failed", "cancelled"] as const;

export type WikiProduceReceiptStatus = (typeof WIKI_PRODUCE_RECEIPT_STATUSES)[number];
export const WikiProduceToolStatusSchema = z.enum(WIKI_PRODUCE_RECEIPT_STATUSES);
export type WikiProduceToolStatus = z.infer<typeof WikiProduceToolStatusSchema>;
