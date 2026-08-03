/**
 * Plan-gate coverage matrix: CoverageUnit rows (source | surface) with
 * covered / gap / cancelled status. Emphasizes source units for multi-source
 * and surface units for large single-repo inventories.
 */

import type { CoverageResult, CoverageResultRow, CoverageStopReason } from "@okf-wiki/contract/coverage";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatMessage, type MessageTree } from "../../i18n";
import { coverageStatusCounts, sortCoverageRows } from "./plan-review-utils";

function statusBadgeVariant(
  status: CoverageResultRow["status"],
): "default" | "destructive" | "secondary" | "outline" {
  if (status === "gap") return "destructive";
  if (status === "covered") return "secondary";
  return "outline";
}

function statusLabel(status: CoverageResultRow["status"], t: MessageTree): string {
  if (status === "covered") return t.specReview.coverageStatusCovered;
  if (status === "gap") return t.specReview.coverageStatusGap;
  return t.specReview.coverageStatusCancelled;
}

function kindLabel(kind: CoverageResultRow["kind"], t: MessageTree): string {
  return kind === "source" ? t.specReview.coverageKindSource : t.specReview.coverageKindSurface;
}

function stopReasonLabel(reason: CoverageStopReason | undefined, t: MessageTree): string | null {
  if (!reason) return null;
  if (reason === "complete") return t.specReview.coverageStopComplete;
  if (reason === "coverage_gap") return t.specReview.coverageStopGap;
  return t.specReview.coverageStopNotRequired;
}

export function CoverageMatrixPanel({
  coverage,
  stopReason,
  coverageRounds,
  t,
  className,
}: {
  coverage: CoverageResult;
  stopReason?: CoverageStopReason;
  coverageRounds?: number;
  t: MessageTree;
  className?: string;
}) {
  const rows = sortCoverageRows(coverage.rows);
  const counts = coverageStatusCounts(coverage);
  const hasSourceUnits = rows.some((row) => row.kind === "source");
  const effectiveStop = stopReason ?? coverage.stop_reason;
  const stopLabel = stopReasonLabel(effectiveStop, t);
  const hasGaps = counts.gap > 0 || effectiveStop === "coverage_gap" || !coverage.ok;

  if (coverage.rows.length === 0 && effectiveStop === "not_required") {
    return (
      <section
        className={cn("space-y-2", className)}
        data-testid="coverage-matrix-panel"
        data-stop-reason={effectiveStop}
      >
        <h3 className="text-sm font-medium">{t.specReview.coverage}</h3>
        <p className="text-sm text-muted-foreground">{t.specReview.coverageNotRequired}</p>
      </section>
    );
  }

  if (coverage.rows.length === 0) {
    return null;
  }

  return (
    <section
      className={cn("space-y-3", className)}
      data-testid="coverage-matrix-panel"
      data-stop-reason={effectiveStop}
      data-has-gaps={hasGaps ? "true" : "false"}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{t.specReview.coverage}</h3>
        <p className="text-xs tabular-nums text-muted-foreground">
          {formatMessage(t.specReview.coverageCounts, {
            covered: counts.covered,
            gap: counts.gap,
            cancelled: counts.cancelled,
            total: counts.total,
          })}
          {stopLabel ? ` · ${stopLabel}` : null}
          {typeof coverageRounds === "number" && coverageRounds > 0
            ? ` · ${formatMessage(t.specReview.coverageRounds, { count: coverageRounds })}`
            : null}
        </p>
      </div>
      {hasGaps ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
          data-testid="coverage-gap-banner"
        >
          {t.specReview.coverageGapBlocksApprove}
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.specReview.coverageUnitId}</TableHead>
            <TableHead>{t.specReview.coverageKind}</TableHead>
            <TableHead>{t.specReview.coverageStatus}</TableHead>
            <TableHead className="text-right">{t.specReview.coveragePageCount}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const emphasize =
              (hasSourceUnits && row.kind === "source") ||
              (!hasSourceUnits && row.kind === "surface");
            return (
              <TableRow
                key={row.unitId}
                data-testid="coverage-row"
                data-unit-id={row.unitId}
                data-kind={row.kind}
                data-status={row.status}
                className={cn(
                  row.status === "gap" && "bg-destructive/5 hover:bg-destructive/10",
                  emphasize && row.status !== "gap" && "bg-muted/30",
                )}
              >
                <TableCell
                  className={cn(
                    "max-w-[18rem] truncate font-mono text-xs",
                    emphasize && "font-medium text-foreground",
                  )}
                  title={row.unitId}
                >
                  {row.unitId}
                </TableCell>
                <TableCell>
                  <Badge variant={emphasize ? "secondary" : "outline"}>{kindLabel(row.kind, t)}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(row.status)}>{statusLabel(row.status, t)}</Badge>
                  {row.reason && row.status !== "covered" ? (
                    <p className="mt-1 max-w-xs truncate text-xs text-muted-foreground" title={row.reason}>
                      {row.reason}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {row.status === "covered" ? row.coveredBy.length : "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

/** Compact one-line coverage strip for observation chrome. */
export function CoverageStrip({
  coverage,
  stopReason,
  t,
  className,
}: {
  coverage: CoverageResult | null | undefined;
  stopReason?: CoverageStopReason;
  t: MessageTree;
  className?: string;
}) {
  if (!coverage && !stopReason) return null;
  const counts = coverageStatusCounts(coverage);
  const effectiveStop = stopReason ?? coverage?.stop_reason;
  if (effectiveStop === "not_required" || (counts.total === 0 && !coverage?.gaps.length)) {
    return null;
  }
  const hasGaps =
    counts.gap > 0 ||
    effectiveStop === "coverage_gap" ||
    coverage?.ok === false ||
    (coverage?.gaps.length ?? 0) > 0;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-xs tabular-nums",
        hasGaps ? "text-destructive" : "text-muted-foreground",
        className,
      )}
      data-testid="coverage-strip"
      data-has-gaps={hasGaps ? "true" : "false"}
    >
      <span className="font-medium">{t.specReview.coverage}</span>
      <span>
        {formatMessage(t.specReview.coverageCounts, {
          covered: counts.covered,
          gap: counts.gap,
          cancelled: counts.cancelled,
          total: counts.total || counts.covered + counts.gap + counts.cancelled,
        })}
      </span>
      {hasGaps ? (
        <Badge variant="destructive">{t.specReview.coverageStatusGap}</Badge>
      ) : (
        <Badge variant="secondary">{t.specReview.coverageStatusCovered}</Badge>
      )}
    </div>
  );
}
