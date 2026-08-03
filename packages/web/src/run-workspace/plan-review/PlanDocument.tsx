/**
 * Readable sealed plan document: Spec body + host ExecutionPlan summary.
 * Shared by plan-gate decision surface and observation Plan tab.
 * Optional coverage / scouts / page-set diff when present on plan-review.
 */

import type { WikiRunPlanReview, WikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { Badge } from "@/components/ui/badge";
import { formatMessage, type MessageTree } from "../../i18n";
import { CoverageMatrixPanel, CoverageStrip } from "./CoverageMatrixPanel";
import { hasScoutsSummary, pageSetDiffHasChanges } from "./plan-review-utils";
import { ScoutsSummary } from "./ScoutsSummary";
import { SpecPageSetDiff } from "./SpecPageSetDiff";

export function PlanDocument({
  review,
  t,
}: {
  review: WikiRunPlanReview;
  t: MessageTree;
}) {
  const { spec, execution } = review;
  const showCoverage = Boolean(review.coverage);
  const showScouts = hasScoutsSummary(review.scoutsSummary);
  const showPageDiff =
    Boolean(review.pageSetDiff) &&
    (pageSetDiffHasChanges(review.pageSetDiff) ||
      (review.pageSetDiff?.retained.length ?? 0) > 0 ||
      Boolean(review.priorSpec));

  return (
    <div
      className="mx-auto flex w-full max-w-5xl flex-col gap-8"
      data-testid="plan-document"
      data-payload-digest={review.payloadDigest}
    >
      {showCoverage || showScouts ? (
        <div className="flex flex-col gap-4 border-b border-border pb-4">
          {showCoverage && review.coverage ? (
            <CoverageStrip
              coverage={review.coverage}
              stopReason={review.coverageStopReason}
              t={t}
            />
          ) : null}
          {showScouts && review.scoutsSummary ? (
            <ScoutsSummary scouts={review.scoutsSummary} t={t} />
          ) : null}
        </div>
      ) : null}

      <SpecSections spec={spec} t={t} />

      {showCoverage && review.coverage ? (
        <CoverageMatrixPanel
          coverage={review.coverage}
          stopReason={review.coverageStopReason}
          coverageRounds={review.coverageRounds}
          t={t}
        />
      ) : null}

      {showPageDiff && review.pageSetDiff ? (
        <SpecPageSetDiff
          pageSetDiff={review.pageSetDiff}
          priorSpec={review.priorSpec}
          t={t}
        />
      ) : null}

      <section data-testid="plan-execution-summary">
        <h3 className="text-sm font-medium">{t.specReview.execution}</h3>
        <dl className="mt-3 grid gap-x-6 gap-y-3 border-y border-border py-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t.specReview.workUnits}</dt>
            <dd className="mt-1 tabular-nums">{execution.workUnitCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.specReview.fanOut}</dt>
            <dd className="mt-1 tabular-nums">
              {formatMessage(t.specReview.fanOutValue, {
                domains: execution.domainCount,
                maxDomains: execution.maxDomainFanOut,
                leaves: execution.leafCount,
                maxLeaves: execution.maxLeafFanOut,
              })}
            </dd>
          </div>
          {execution.reviewLenses.length > 0 ? (
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">{t.specReview.reviewLenses}</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {execution.reviewLenses.map((lens) => (
                  <Badge key={lens} variant="outline">
                    {lens}
                  </Badge>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
        {execution.workUnits.length > 0 ? (
          <div className="mt-3 divide-y divide-border border-y border-border">
            {execution.workUnitCount > execution.workUnits.length ? (
              <p className="py-2 text-xs text-muted-foreground">
                {formatMessage(t.specReview.workUnitsTruncated, {
                  shown: execution.workUnits.length,
                  total: execution.workUnitCount,
                })}
              </p>
            ) : null}
            {execution.workUnits.map((unit) => (
              <div key={unit.id} className="py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-xs">{unit.id}</p>
                  {unit.domainId ? <Badge variant="outline">{unit.domainId}</Badge> : null}
                  <span className="text-xs text-muted-foreground">
                    {unit.questionCount} {t.specReview.questions}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{unit.scope}</p>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** Spec-only sections (also usable when only WikiRunSpec is available). */
export function SpecSections({ spec, t }: { spec: WikiRunSpec; t: MessageTree }) {
  return (
    <>
      <section>
        <h3 className="text-sm font-medium">{t.specReview.audience}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{spec.audience}</p>
        <p className="mt-3 max-w-4xl text-sm">{spec.summary}</p>
      </section>
      <section>
        <h3 className="text-sm font-medium">{t.specReview.domains}</h3>
        <div className="mt-3 divide-y divide-border border-y border-border">
          {spec.domains.map((domain) => (
            <div key={domain.id} className="py-3" data-testid="plan-domain">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{domain.title}</p>
                <Badge variant="outline">
                  {domain.critical ? t.specReview.blocking : t.specReview.optional}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{domain.scope}</p>
              {domain.questions.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {domain.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section>
        <h3 className="text-sm font-medium">{t.specReview.pages}</h3>
        <div className="mt-3 divide-y divide-border border-y border-border">
          {spec.pages.map((page) => (
            <div key={page.path} className="py-3" data-testid="plan-page">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-xs">{page.path}</p>
                {page.template ? <Badge variant="outline">{page.template}</Badge> : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{page.purpose}</p>
              {page.questions.length > 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">{page.questions.join(" · ")}</p>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      {spec.openQuestions.length > 0 ? (
        <section>
          <h3 className="text-sm font-medium">{t.specReview.openQuestions}</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            {spec.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {spec.notes?.trim() || spec.changelog.length > 0 ? (
        <section>
          <h3 className="text-sm font-medium">{t.specReview.trail}</h3>
          {spec.notes?.trim() ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{spec.notes}</p>
          ) : null}
          {spec.changelog.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {spec.changelog.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <section>
        <h3 className="text-sm font-medium">{t.specReview.acceptance}</h3>
        <dl className="mt-3 grid gap-x-6 gap-y-3 border-y border-border py-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.reviewEnabled}</dt>
            <dd className="mt-1">{spec.acceptance.reviewRequired ? t.common.on : t.common.off}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.autoRepair}</dt>
            <dd className="mt-1">{spec.acceptance.autoRepair ? t.common.on : t.common.off}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.semanticRepairRounds}</dt>
            <dd className="mt-1">{spec.acceptance.maxRepairRounds}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.workbench.mechanicalRepairRounds}</dt>
            <dd className="mt-1">{spec.acceptance.maxHardValidateRepairRounds}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
