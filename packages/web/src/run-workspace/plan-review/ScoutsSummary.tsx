/**
 * Plan scout receipt summary for plan-gate review.
 */

import type { WikiRunPlanReviewScoutsSummary } from "@okf-wiki/contract";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMessage, type MessageTree } from "../../i18n";
import { hasScoutsSummary } from "./plan-review-utils";

export function ScoutsSummary({
  scouts,
  t,
  className,
}: {
  scouts: WikiRunPlanReviewScoutsSummary;
  t: MessageTree;
  className?: string;
}) {
  if (!hasScoutsSummary(scouts)) return null;

  return (
    <section className={cn("space-y-2", className)} data-testid="scouts-summary">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{t.specReview.scouts}</h3>
        <p className="text-xs tabular-nums text-muted-foreground">
          {formatMessage(t.specReview.scoutsReceipts, { count: scouts.receiptCount })}
          {scouts.mode ? ` · ${scouts.mode}` : null}
        </p>
      </div>
      {scouts.kinds.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {scouts.kinds.map((kind) => (
            <Badge key={kind} variant="outline">
              {kind}
            </Badge>
          ))}
        </div>
      ) : null}
    </section>
  );
}
