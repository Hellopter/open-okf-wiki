/**
 * wiki_produce panel — durable WikiRuns projection (ADR 0035).
 *
 * Tool details only carry the StartRun receipt (accepted+runId). Live status
 * and open plan/publication gates come from useWikiRun (GET + EventSource).
 * Plan HITL uses ResolveGate on the Run API.
 *
 * Control chrome (full graph, failed-node retry/rerun, NodeAttemptDialog)
 * lives in RunInspectorDialog — open via run id link or "View run".
 */

import type {
  ResolveGateCommand,
  WikiProduceToolDetails,
  WikiRunGateKind,
  WikiRunSpec,
} from "@okf-wiki/contract";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { dispatchWikiRunCommand, getWikiRunSpec } from "../../api";
import { useI18n } from "../../i18n";
import { useWikiRun } from "../hooks/useWikiRun";
import { compactSummary } from "../run-graph/compact-summary";
import { RunInspectorDialog } from "../run-graph/RunInspectorDialog";
import { wikiRunToViewModel } from "../run-graph/wiki-run-view-model";
import { FixGatePanel } from "./FixGatePanel";
import { selectPrimaryOpenGate } from "./fix-gate";
import { SpecReviewView } from "./SpecReviewView";

export type WikiProduceGatePanelProps = {
  details: WikiProduceToolDetails;
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}

function gateTitle(kind: WikiRunGateKind, t: ReturnType<typeof useI18n>["t"]): string {
  if (kind === "plan") return t.planConfirm.title;
  if (kind === "publication") return t.runStatus.awaiting_publication;
  if (kind === "fix") return t.fixConfirm.title;
  return kind;
}

export function WikiProduceGatePanel({ details }: WikiProduceGatePanelProps) {
  const { t } = useI18n();
  const { id: routeWorkspaceId = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const runId = details.runId ?? null;

  const wikiRun = useWikiRun({
    workspaceId: routeWorkspaceId,
    runId,
    rootPath: rootPathHint,
    enabled: Boolean(runId && routeWorkspaceId),
  });

  const snapshot = wikiRun.snapshot;
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [activeGateId, setActiveGateId] = useState<string | null>(null);
  const [planSpec, setPlanSpec] = useState<WikiRunSpec | null>(null);
  const [planSpecLoading, setPlanSpecLoading] = useState(false);
  const [planSpecError, setPlanSpecError] = useState<string | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setRevising(false);
    setFeedback("");
    setCommandError(null);
    setActiveGateId(null);
    setPlanSpec(null);
    setPlanSpecError(null);
  }, [runId]);

  const openGates = viewModel?.openGates ?? [];
  const primaryGate = selectPrimaryOpenGate(openGates);

  // Load sealed Spec whenever a plan gate is open (or after plan succeeded for review).
  const wantPlanSpec =
    Boolean(runId && routeWorkspaceId) &&
    (primaryGate?.kind === "plan" ||
      Boolean(snapshot?.nodes.some((n) => n.key === "plan" && n.state === "succeeded")));

  useEffect(() => {
    if (!wantPlanSpec || !runId || !routeWorkspaceId) {
      setPlanSpec(null);
      setPlanSpecError(null);
      setPlanSpecLoading(false);
      return;
    }
    let cancelled = false;
    setPlanSpecLoading(true);
    setPlanSpecError(null);
    void getWikiRunSpec(routeWorkspaceId, runId, rootPathHint)
      .then((body) => {
        if (cancelled) return;
        setPlanSpec(body.spec);
        setPlanSpecLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPlanSpec(null);
        setPlanSpecLoading(false);
        setPlanSpecError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [wantPlanSpec, runId, routeWorkspaceId, rootPathHint, primaryGate?.gateId, snapshot?.revision]);

  const dispatchCommand = async (
    command: Parameters<typeof dispatchWikiRunCommand>[1],
  ): Promise<boolean> => {
    if (!routeWorkspaceId || submitting) return false;
    setSubmitting(true);
    setCommandError(null);
    try {
      await dispatchWikiRunCommand(routeWorkspaceId, command, rootPathHint);
      setSubmitting(false);
      return true;
    } catch (error) {
      setSubmitting(false);
      setCommandError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const decide = async (action: "approve" | "deny" | "revise") => {
    if (!primaryGate || !runId) return;
    if (primaryGate.kind === "fix") return;
    if (action === "revise" && !feedback.trim()) {
      setRevising(true);
      setActiveGateId(primaryGate.gateId);
      return;
    }
    const ok = await dispatchCommand({
      type: "resolve_gate",
      commandId: crypto.randomUUID(),
      runId,
      gateId: primaryGate.gateId,
      gateKind: primaryGate.kind,
      payloadDigest: primaryGate.payloadDigest,
      decision: action,
      ...(action === "revise" ? { feedback: feedback.trim() } : {}),
    });
    if (ok) {
      setRevising(false);
      setFeedback("");
      setActiveGateId(null);
    }
  };

  const resolveFixGate = async (command: ResolveGateCommand): Promise<boolean> => {
    const ok = await dispatchCommand(command);
    if (ok) {
      setRevising(false);
      setFeedback("");
      setActiveGateId(null);
    }
    return ok;
  };

  const statusLabel = snapshot
    ? snapshot.state
    : details.status === "accepted"
      ? "accepted"
      : details.status;

  const oneLineSummary =
    compactSummary(details.summary, 96) ||
    compactSummary(snapshot ? `rev ${snapshot.revision}` : undefined, 96);

  /** Prefer live sealed Spec pages; receipt pages are historical only. */
  const pages =
    planSpec?.pages.map((page) => page.path) ?? details.pages ?? [];

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
          <Badge variant={primaryGate ? "default" : "secondary"}>{statusLabel}</Badge>
          {wikiRun.connectionStatus === "reconnecting" ? (
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
            onClick={() => setInspectorOpen(true)}
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

      {runId && !wikiRun.ready && !wikiRun.error ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {t.common.loading}
        </div>
      ) : null}

      {wikiRun.error ? (
        <p className="text-xs text-destructive" data-testid="wiki-produce-run-error">
          {wikiRun.error}
        </p>
      ) : null}

      {primaryGate?.kind === "plan" || planSpec ? (
        <div
          className="flex flex-col gap-1.5 border-t border-border/60 pt-2"
          data-testid="wiki-produce-plan-review"
        >
          {planSpecLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t.common.loading}
            </div>
          ) : null}
          {planSpecError ? (
            <p className="text-xs text-destructive" data-testid="wiki-produce-plan-spec-error">
              {planSpecError}
            </p>
          ) : null}
          {planSpec ? <SpecReviewView spec={planSpec} /> : null}
        </div>
      ) : null}

      {!planSpec && pages.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="okf-section-label">
            {t.planConfirm.pagesLabel} · {pages.length}
          </p>
          <ul className="flex flex-wrap gap-1">
            {pages.map((page) => (
              <li key={page}>
                <Badge variant="outline" className="max-w-[12rem] font-mono text-2xs font-normal">
                  <span className="truncate">{page}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {runId && routeWorkspaceId ? (
        <div className="border-t border-border/60 pt-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="wiki-produce-view-run"
            onClick={() => setInspectorOpen(true)}
          >
            {t.runInspector.viewRun}
          </Button>
          <RunInspectorDialog
            workspaceId={routeWorkspaceId}
            rootPath={rootPathHint}
            runId={runId}
            open={inspectorOpen}
            onOpenChange={setInspectorOpen}
          />
        </div>
      ) : null}

      {primaryGate && runId && primaryGate.kind === "fix" ? (
        <FixGatePanel
          gate={primaryGate}
          runId={runId}
          snapshot={snapshot}
          submitting={submitting}
          commandError={commandError}
          onResolve={resolveFixGate}
        />
      ) : primaryGate && runId ? (
        <div
          className="flex flex-col gap-2 border-t border-border/60 pt-2"
          data-testid={`agent-${primaryGate.kind}-gate`}
          data-gate-kind={primaryGate.kind}
          data-gate-id={primaryGate.gateId}
          data-gate-state={primaryGate.state}
        >
          <p className="text-xs font-medium">{gateTitle(primaryGate.kind, t)}</p>
          {commandError ? (
            <p className="text-xs text-destructive" data-testid="agent-gate-error">
              {commandError}
            </p>
          ) : null}
          {revising && primaryGate.kind === "plan" && activeGateId === primaryGate.gateId ? (
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="agent-gate-feedback" className="text-xs">
                {t.planConfirm.reviseLabel}
              </FieldLabel>
              <Textarea
                id="agent-gate-feedback"
                data-testid="agent-gate-feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.planConfirm.revisePlaceholder}
                disabled={submitting}
                rows={2}
                className="min-h-16 text-xs"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {primaryGate.kind === "operator_input" ? null : (
              <Button
                type="button"
                size="sm"
                data-testid="agent-gate-approve"
                disabled={submitting || revising}
                onClick={() => void decide("approve")}
              >
                {submitting
                  ? t.planConfirm.working
                  : primaryGate.kind === "plan"
                    ? t.planConfirm.approve
                    : t.planConfirm.chipPublish}
              </Button>
            )}
            {primaryGate.kind === "plan" ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={revising ? "agent-gate-revise-submit" : "agent-gate-revise"}
                disabled={submitting || (revising && !feedback.trim())}
                onClick={() => {
                  if (!revising) {
                    setRevising(true);
                    setActiveGateId(primaryGate.gateId);
                  } else void decide("revise");
                }}
              >
                {revising ? t.planConfirm.reviseSubmit : t.planConfirm.revise}
              </Button>
            ) : null}
            {revising ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="agent-gate-revise-cancel"
                disabled={submitting}
                onClick={() => {
                  setRevising(false);
                  setFeedback("");
                  setActiveGateId(null);
                }}
              >
                {t.common.cancel}
              </Button>
            ) : primaryGate.kind !== "operator_input" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="agent-gate-deny"
                disabled={submitting}
                onClick={() => void decide("deny")}
              >
                {primaryGate.kind === "plan"
                  ? t.planConfirm.decline
                  : t.planConfirm.chipKeepStaging}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
