/**
 * Normalize ControlReturn summaries for handoff (pure).
 */

import type { ControlReturn } from "@okf-wiki/contract";
import { ControlReturnSchema } from "@okf-wiki/contract";

const SUMMARY_CAP = 4_000;

export function truncateControlSummary(text: string, max = SUMMARY_CAP): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Validate and cap summary on a control-plane handoff. */
export function normalizeControlReturn(input: ControlReturn): ControlReturn {
  return ControlReturnSchema.parse({
    ...input,
    summary: truncateControlSummary(input.summary),
  });
}
