/**
 * Plan-gate document review: sticky decision chrome + full sealed Spec body.
 * Parent owns resolve_gate dispatch and (preferably) a single usePlanReview owner.
 */

import type { RunCommand, WikiRunGate, WikiRunSnapshot } from "@okf-wiki/contract";
import { LoaderCircleIcon, SendIcon } from "lucide-react";
import { useState } from "react";
import { ActivityCollapsible } from "@/components/agent-ui";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatMessage, type MessageTree } from "../../i18n";
import { newCommandId } from "../../lib/command-id";
import { localizedLabel } from "../../agent-workspace/workbench-utils";
import { CoverageStrip } from "./CoverageMatrixPanel";
import { PlanDocument } from "./PlanDocument";
import {
  coverageBlocksApprove,
  formatDomainPageCounts,
  planReviewHeadline,
  type PlanReviewState,
} from "./plan-review-utils";
import { usePlanReview } from "./usePlanReview";

export type PlanGateReviewPanelProps = {
  workspaceId: string;
  snapshot: WikiRunSnapshot;
  gate: WikiRunGate;
  onRunCommand: (command: (latest: WikiRunSnapshot) => RunCommand) => void;
  t: MessageTree;
  className?: string;
  /**
   * Shared plan-review state from a parent owner (e.g. useRunObservation).
   * When omitted, the panel fetches once for standalone surfaces (RunDetailPage).
   */
  reviewState?: PlanReviewState & { retry: () => void };
};

export function PlanGateReviewPanel({
  workspaceId,
  snapshot,
  gate,
  onRunCommand,
  t,
  className,
  reviewState: externalReview,
}: PlanGateReviewPanelProps) {
  const internalReview = usePlanReview(
    workspaceId,
    snapshot.runId,
    snapshot,
    externalReview === undefined,
  );
  const reviewState = externalReview ?? internalReview;
  const [feedback, setFeedback] = useState("");

  const resolve = (decision: "approve" | "deny" | "revise") => {
    onRunCommand((latest) => {
      const current = latest.gates.find((item) => item.gateId === gate.gateId && item.state === "open");
      if (!current) {
        throw new Error("This gate has already changed. Refresh the Run before deciding.");
      }
      return {
        type: "resolve_gate",
        commandId: newCommandId(),
        runId: latest.runId,
        expectedRevision: latest.revision,
        gateId: current.gateId,
        gateKind: "plan",
        payloadDigest: current.payloadDigest,
        decision,
        ...(decision === "revise" && feedback.trim() ? { feedback: feedback.trim() } : {}),
      } as RunCommand;
    });
  };

  const headline = planReviewHeadline(reviewState, gate, {
    fallback: t.workbench.decisionFallback,
    loading: t.specReview.loading,
  });
  const counts =
    reviewState.review != null
      ? {
          domains: reviewState.review.spec.domains.length,
          pages: reviewState.review.spec.pages.length,
          openQuestions: reviewState.review.spec.openQuestions.length,
        }
      : {
          domains: gate.detail?.domainCount,
          pages: gate.detail?.pageCount,
          openQuestions: gate.detail?.openQuestionCount,
        };
  const countsLine = formatDomainPageCounts(
    counts.domains,
    counts.pages,
    t.specReview.domainPageCounts,
    formatMessage,
  );
  const decisionsReady = reviewState.status === "ready" && reviewState.review != null;
  const approveBlockedByCoverage = coverageBlocksApprove(reviewState.review);
  const canApprove = decisionsReady && !approveBlockedByCoverage;

  return (
    <section
      className={className}
      data-testid="plan-gate-review-panel"
      data-slot="plan-gate-review"
      data-coverage-blocks-approve={approveBlockedByCoverage ? "true" : "false"}
    >
      <div className="sticky top-0 z-10 space-y-3 border-y border-border bg-background/95 px-3 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div>
          <h3 className="text-sm font-semibold">
            {formatMessage(t.workbench.decisionTitle, {
              kind: localizedLabel(t.workbench.gateKinds, "plan"),
            })}
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{headline}</p>
          {countsLine || typeof counts.openQuestions === "number" ? (
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {[
                countsLine,
                typeof counts.openQuestions === "number" && counts.openQuestions > 0
                  ? formatMessage(t.specReview.openQuestionCount, {
                      count: counts.openQuestions,
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {reviewState.review?.coverage ? (
            <CoverageStrip
              className="mt-2"
              coverage={reviewState.review.coverage}
              stopReason={reviewState.review.coverageStopReason}
              t={t}
            />
          ) : null}
          {approveBlockedByCoverage ? (
            <p
              className="mt-2 text-xs text-destructive"
              data-testid="plan-gate-coverage-blocked"
            >
              {t.specReview.coverageGapBlocksApprove}
            </p>
          ) : null}
        </div>
        <Textarea
          className="min-h-20"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t.workbench.guidancePlaceholder}
          aria-label={t.workbench.guidancePlaceholder}
          disabled={!decisionsReady}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            onClick={() => resolve("approve")}
            disabled={!canApprove}
            data-testid="plan-gate-approve"
            title={
              approveBlockedByCoverage ? t.specReview.coverageGapBlocksApprove : undefined
            }
          >
            {t.workbench.approve}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => resolve("revise")}
            disabled={!decisionsReady || !feedback.trim()}
            data-testid="plan-gate-revise"
          >
            {t.workbench.revise}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => resolve("deny")}
            disabled={!decisionsReady}
            data-testid="plan-gate-deny"
          >
            {t.workbench.decline}
          </Button>
        </div>
      </div>

      <div className="px-3 py-5 md:px-4">
        {reviewState.status === "loading" || reviewState.status === "stale" ? (
          <p
            className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
            data-testid="plan-review-loading"
          >
            <LoaderCircleIcon className="size-4 animate-spin" />
            {reviewState.status === "stale" ? t.specReview.refreshing : t.specReview.loading}
          </p>
        ) : null}
        {reviewState.status === "pending" ? (
          <p
            className="py-8 text-center text-sm text-muted-foreground"
            data-testid="plan-review-pending"
          >
            {t.workbench.planPending}
          </p>
        ) : null}
        {reviewState.status === "error" ? (
          <div className="space-y-3 py-6" data-testid="plan-review-error">
            <p className="text-sm text-destructive">{t.specReview.loadError}</p>
            <Button size="sm" variant="outline" onClick={() => reviewState.retry()}>
              <SendIcon data-icon="inline-start" />
              {t.specReview.retry}
            </Button>
          </div>
        ) : null}
        {reviewState.review && (reviewState.status === "ready" || reviewState.status === "stale") ? (
          <PlanDocument review={reviewState.review} t={t} />
        ) : null}
      </div>

      <div className="border-t border-border px-3 py-2">
        <ActivityCollapsible
          defaultOpen={false}
          trigger={
            <span className="text-xs font-medium text-muted-foreground">
              {t.workbench.technicalDetails}
            </span>
          }
          contentClassName="mt-2 space-y-1 font-mono text-xs text-muted-foreground"
        >
          <p>gateId: {gate.gateId}</p>
          <p>payloadDigest: {gate.payloadDigest}</p>
          {reviewState.review ? (
            <>
              <p>specDigest: {reviewState.review.specDigest}</p>
              <p>planDigest: {reviewState.review.planDigest}</p>
            </>
          ) : null}
        </ActivityCollapsible>
      </div>
    </section>
  );
}
