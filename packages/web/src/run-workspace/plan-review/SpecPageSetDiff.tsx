/**
 * Prior Spec vs current page-path set on plan revise (paths only).
 */

import type { WikiRunPlanReviewPageSetDiff, WikiRunSpec } from "@okf-wiki/contract";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatMessage, type MessageTree } from "../../i18n";
import { pageSetDiffHasChanges } from "./plan-review-utils";

function PathList({
  paths,
  empty,
  tone,
  testId,
}: {
  paths: readonly string[];
  empty: string;
  tone: "added" | "removed" | "retained";
  testId: string;
}) {
  if (paths.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-border border-y border-border" data-testid={testId}>
      {paths.map((path) => (
        <li
          key={path}
          className={cn(
            "py-1.5 font-mono text-xs",
            tone === "added" && "text-foreground",
            tone === "removed" && "text-muted-foreground line-through",
            tone === "retained" && "text-muted-foreground",
          )}
        >
          {path}
        </li>
      ))}
    </ul>
  );
}

export function SpecPageSetDiff({
  pageSetDiff,
  priorSpec,
  t,
  className,
}: {
  pageSetDiff: WikiRunPlanReviewPageSetDiff;
  priorSpec?: WikiRunSpec;
  t: MessageTree;
  className?: string;
}) {
  if (!pageSetDiffHasChanges(pageSetDiff) && pageSetDiff.retained.length === 0) {
    return null;
  }

  return (
    <section
      className={cn("space-y-4", className)}
      data-testid="spec-page-set-diff"
      data-added={pageSetDiff.added.length}
      data-removed={pageSetDiff.removed.length}
      data-retained={pageSetDiff.retained.length}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{t.specReview.pageSetDiff}</h3>
        <p className="text-xs tabular-nums text-muted-foreground">
          {formatMessage(t.specReview.pageSetDiffCounts, {
            added: pageSetDiff.added.length,
            removed: pageSetDiff.removed.length,
            retained: pageSetDiff.retained.length,
          })}
        </p>
      </div>
      {priorSpec?.summary?.trim() ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t.specReview.priorSpec}</span>
          {": "}
          {priorSpec.summary.trim()}
        </p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="secondary">{t.specReview.pageSetAdded}</Badge>
            <span className="text-xs tabular-nums text-muted-foreground">
              {pageSetDiff.added.length}
            </span>
          </div>
          <PathList
            paths={pageSetDiff.added}
            empty={t.specReview.pageSetNone}
            tone="added"
            testId="page-set-added"
          />
        </div>
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline">{t.specReview.pageSetRemoved}</Badge>
            <span className="text-xs tabular-nums text-muted-foreground">
              {pageSetDiff.removed.length}
            </span>
          </div>
          <PathList
            paths={pageSetDiff.removed}
            empty={t.specReview.pageSetNone}
            tone="removed"
            testId="page-set-removed"
          />
        </div>
      </div>
      {pageSetDiff.retained.length > 0 ? (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline">{t.specReview.pageSetRetained}</Badge>
            <span className="text-xs tabular-nums text-muted-foreground">
              {pageSetDiff.retained.length}
            </span>
          </div>
          <PathList
            paths={pageSetDiff.retained}
            empty={t.specReview.pageSetNone}
            tone="retained"
            testId="page-set-retained"
          />
        </div>
      ) : null}
    </section>
  );
}
