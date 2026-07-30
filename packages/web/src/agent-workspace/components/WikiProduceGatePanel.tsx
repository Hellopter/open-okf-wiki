/**
 * wiki_produce receipt card — read-only StartRun handoff (ADR 0035 / Phase 6).
 *
 * Tool details only carry the StartRun receipt (accepted+runId). Live status
 * comes from the shell WikiRunProjectionContext when URL `?run=` matches.
 * HITL decisions live on the shell Active Run bar — not this card.
 *
 * Clicking the short runId sets URL `?run=` only (focus active run; does not
 * open graph / inspector).
 */

import type { WikiProduceToolDetails } from "@okf-wiki/contract";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "../../i18n";
import {
  selectMatchingProjection,
  useWikiRunProjection,
} from "../hooks/WikiRunProjectionContext";
import { compactSummary } from "../run-graph/compact-summary";

export type WikiProduceGatePanelProps = {
  details: WikiProduceToolDetails;
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}

export function WikiProduceGatePanel({ details }: WikiProduceGatePanelProps) {
  const { t } = useI18n();
  const [, setSearchParams] = useSearchParams();
  const runId = details.runId ?? null;

  // Shell owns the sole active-run subscription; match by runId (no second EventSource).
  const shellProjection = useWikiRunProjection();
  const wikiRun = selectMatchingProjection(shellProjection, runId);
  const snapshot = wikiRun.snapshot;

  const statusLabel = snapshot
    ? snapshot.state
    : details.status === "accepted"
      ? "accepted"
      : details.status;

  const oneLineSummary =
    compactSummary(details.summary, 96) ||
    compactSummary(snapshot ? `rev ${snapshot.revision}` : undefined, 96);

  // Matching active run still loading; non-matching cards stay receipt-only (no spinner).
  const showLiveLoading = wikiRun.matches && !wikiRun.ready && !wikiRun.error;

  const focusRun = (id: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("rootPath");
        next.set("run", id);
        next.delete("attempt");
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div
      className="flex flex-col gap-2.5 rounded-md border border-border/70 bg-muted/15 p-2.5"
      data-testid="wiki-produce-details"
      data-wiki-status={details.status}
      data-wiki-run-state={snapshot?.state}
      data-wiki-run-id={runId ?? undefined}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{statusLabel}</Badge>
          {wikiRun.matches && wikiRun.connectionStatus === "reconnecting" ? (
            <span className="text-2xs text-muted-foreground">
              {t.agentWorkspace.connectionReconnecting}
            </span>
          ) : null}
          {oneLineSummary ? (
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={details.summary}
            >
              {oneLineSummary}
            </span>
          ) : null}
        </div>
        {runId ? (
          <button
            type="button"
            className="shrink-0 font-mono text-2xs text-primary underline-offset-2 hover:underline"
            title={runId}
            data-testid="wiki-produce-run-id-link"
            onClick={() => focusRun(runId)}
          >
            {shortRunId(runId)}
          </button>
        ) : null}
      </div>

      {details.status === "accepted" && runId ? (
        <p className="text-xs text-muted-foreground" data-testid="wiki-produce-accepted-hint">
          {t.agentWorkspace.wikiRunAcceptedHint}
        </p>
      ) : null}

      {showLiveLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {t.common.loading}
        </div>
      ) : null}

      {wikiRun.matches && wikiRun.error ? (
        <p className="text-xs text-destructive" data-testid="wiki-produce-run-error">
          {wikiRun.error}
        </p>
      ) : null}
    </div>
  );
}
