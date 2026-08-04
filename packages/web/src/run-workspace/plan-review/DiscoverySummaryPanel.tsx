/**
 * Soft discovery-map summary for plan-gate review.
 * Shows domain / flow / concept counts when host projects optional discovery fields.
 */

import { cn } from "@/lib/utils";
import { formatMessage, type MessageTree } from "../../i18n";
import {
  hasDiscoverySummary,
  type SoftDiscoverySummary,
} from "./plan-review-utils";

export function DiscoverySummaryPanel({
  summary,
  t,
  className,
}: {
  summary: SoftDiscoverySummary;
  t: MessageTree;
  className?: string;
}) {
  if (!hasDiscoverySummary(summary)) return null;

  const countsLine =
    summary.sources !== undefined
      ? formatMessage(t.specReview.discoveryCountsWithSources, {
          sources: summary.sources,
          domains: summary.domains,
          flows: summary.flows,
          concepts: summary.concepts,
        })
      : formatMessage(t.specReview.discoveryCounts, {
          domains: summary.domains,
          flows: summary.flows,
          concepts: summary.concepts,
        });

  return (
    <section className={cn("space-y-2", className)} data-testid="discovery-summary">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{t.specReview.discovery}</h3>
        <p className="text-xs tabular-nums text-muted-foreground">{countsLine}</p>
      </div>
    </section>
  );
}
