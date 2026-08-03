import type { AttemptTraceEvent } from "@okf-wiki/contract/wiki-runs";

/** Merge paged history and live transcript frames without dropping prior events. */
export function mergeAttemptTraceEvents(
  current: AttemptTraceEvent[],
  incoming: AttemptTraceEvent[],
): AttemptTraceEvent[] {
  const byOrdinal = new Map<number, AttemptTraceEvent>();
  for (const event of current) byOrdinal.set(event.ordinal, event);
  for (const event of incoming) byOrdinal.set(event.ordinal, event);
  return [...byOrdinal.values()].sort((left, right) => left.ordinal - right.ordinal);
}
