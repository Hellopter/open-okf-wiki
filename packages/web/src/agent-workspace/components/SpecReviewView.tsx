/**
 * Full WikiRunSpec review surface (Claude plan-mode style).
 * Used by the plan gate (approve / request changes / decline) and by the
 * Run Inspector for post-run plan review — the operator sees the whole plan
 * (domains, page purposes, questions, acceptance, replan trail), not just
 * a list of page paths.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";
import { ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useI18n } from "../../i18n";

function QuestionList({ questions }: { questions: readonly string[] }) {
  if (questions.length === 0) return null;
  return (
    <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4 text-2xs text-muted-foreground">
      {questions.map((q) => (
        <li key={q}>{q}</li>
      ))}
    </ul>
  );
}

export function SpecReviewView({ spec }: { spec: WikiRunSpec }) {
  const { t } = useI18n();
  const domainTitle = (domainId: string) =>
    spec.domains.find((d) => d.id === domainId)?.title ?? domainId;

  return (
    <div className="flex min-w-0 flex-col gap-3 text-xs" data-testid="spec-review">
      <div className="flex flex-col gap-1">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{spec.summary}</p>
        {spec.audience ? (
          <p className="text-2xs text-muted-foreground">
            {t.specReview.audience} · {spec.audience}
          </p>
        ) : null}
      </div>

      {spec.domains.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="okf-section-label">
            {t.specReview.domains} · {spec.domains.length}
          </p>
          <ul className="flex flex-col gap-1.5">
            {spec.domains.map((domain) => (
              <li
                key={domain.id}
                className="rounded-md border border-border/60 px-2.5 py-1.5"
                data-testid="spec-review-domain"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{domain.title}</span>
                  <span className="font-mono text-2xs text-muted-foreground">{domain.id}</span>
                  {!domain.critical ? (
                    <Badge variant="outline" className="h-4 px-1 text-2xs font-normal">
                      {t.specReview.optional}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-2xs text-muted-foreground">{domain.scope}</p>
                <QuestionList questions={domain.questions} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <p className="okf-section-label">
          {t.specReview.pages} · {spec.pages.length}
        </p>
        <ul className="flex flex-col gap-1.5">
          {spec.pages.map((page) => (
            <li
              key={page.path}
              className="rounded-md border border-border/60 px-2.5 py-1.5"
              data-testid="spec-review-page"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-2xs font-medium">{page.path}</span>
                {page.template ? (
                  <Badge variant="outline" className="h-4 px-1 text-2xs font-normal">
                    {page.template}
                  </Badge>
                ) : null}
                {page.domainIds.map((domainId) => (
                  <span key={domainId} className="text-2xs text-muted-foreground/80">
                    {domainTitle(domainId)}
                  </span>
                ))}
              </div>
              <p className="mt-0.5 text-2xs text-muted-foreground">{page.purpose}</p>
              <QuestionList questions={page.questions} />
            </li>
          ))}
        </ul>
      </div>

      {spec.openQuestions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="okf-section-label">{t.specReview.openQuestions}</p>
          <QuestionList questions={spec.openQuestions} />
        </div>
      ) : null}

      <p className="text-2xs text-muted-foreground">
        {t.specReview.acceptance} · {spec.acceptance.reviewRequired
          ? t.specReview.reviewRequired
          : t.specReview.reviewOptional}
        {" · "}
        {t.specReview.maxRepairRounds}: {spec.acceptance.maxRepairRounds}
        {" · "}
        {t.specReview.blocking}: {spec.acceptance.blockingSeverities.join(", ") || "—"}
      </p>

      {spec.notes || spec.changelog.length > 0 ? (
        <Collapsible className="min-w-0">
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-md text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90" />
            {t.specReview.trail}
            {spec.changelog.length > 0 ? ` · ${spec.changelog.length}` : ""}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 ml-1 min-w-0 border-l-2 border-border/60 pl-2.5">
            {spec.notes ? (
              <p className="whitespace-pre-wrap text-2xs text-muted-foreground">{spec.notes}</p>
            ) : null}
            {spec.changelog.length > 0 ? (
              <ol className="mt-1 flex list-decimal flex-col gap-0.5 pl-4 text-2xs text-muted-foreground">
                {spec.changelog.map((entry, i) => (
                  <li key={`${i}-${entry}`}>{entry}</li>
                ))}
              </ol>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
