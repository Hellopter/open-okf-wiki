/**
 * Session-owned Active Run strip — sole HITL decision surface.
 *
 * URL `?run=` selects the subscribed run (SSE). Graph expand is local state
 * (not tied to opening a Sheet). Tool cards stay read-only.
 */

import type { ResolveGateCommand, WikiRunGateKind } from "@okf-wiki/contract";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { dispatchWikiRunCommand, type WikiRunListItem } from "../../api";
import { useI18n } from "../../i18n";
import {
  selectMatchingProjection,
  useWikiRunProjection,
} from "../hooks/WikiRunProjectionContext";
import { wikiRunToViewModel } from "../run-graph/wiki-run-view-model";
import { FixGatePanel } from "./FixGatePanel";
import { selectPrimaryOpenGate } from "./fix-gate";
import { StatusBadge } from "./StatusBadge";

export type ActiveRunBarProps = {
  workspaceId: string;
  rootPath?: string;
  recentRuns?: WikiRunListItem[];
  /** Local: whether graph/plan details are expanded under the bar. */
  graphOpen: boolean;
  onGraphOpenChange: (open: boolean) => void;
  className?: string;
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}

function gateTitle(kind: WikiRunGateKind, t: ReturnType<typeof useI18n>["t"]): string {
  if (kind === "plan") return t.planConfirm.title;
  if (kind === "publication") return t.runStatus.awaiting_publication;
  if (kind === "fix") return t.fixConfirm.title;
  if (kind === "operator_input") return t.operatorInput.title;
  return kind;
}

export function ActiveRunBar({
  workspaceId,
  rootPath,
  recentRuns = [],
  graphOpen,
  onGraphOpenChange,
  className,
}: ActiveRunBarProps) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get("run");

  const shellProjection = useWikiRunProjection();
  const wikiRun = selectMatchingProjection(shellProjection, runId);
  const snapshot = wikiRun.snapshot;
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);
  const primaryGate = viewModel ? selectPrimaryOpenGate(viewModel.openGates) : null;

  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [operatorAnswer, setOperatorAnswer] = useState("");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [activeGateId, setActiveGateId] = useState<string | null>(null);
  const [runMenuOpen, setRunMenuOpen] = useState(false);

  useEffect(() => {
    setSubmitting(false);
    setRevising(false);
    setFeedback("");
    setOperatorAnswer("");
    setCommandError(null);
    setActiveGateId(null);
    setRunMenuOpen(false);
  }, [runId]);

  if (!runId) return null;

  const selectRun = (nextRunId: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("rootPath");
        next.set("run", nextRunId);
        next.delete("attempt");
        return next;
      },
      { replace: true },
    );
    setRunMenuOpen(false);
  };

  const dispatchCommand = async (
    command: Parameters<typeof dispatchWikiRunCommand>[1],
  ): Promise<boolean> => {
    if (!workspaceId || submitting) return false;
    setSubmitting(true);
    setCommandError(null);
    try {
      await dispatchWikiRunCommand(workspaceId, command, rootPath);
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
    if (primaryGate.kind === "fix" || primaryGate.kind === "operator_input") return;
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

  const answerOperatorInput = async () => {
    if (!primaryGate || primaryGate.kind !== "operator_input") return;
    const answer = operatorAnswer.trim();
    if (!answer) {
      setCommandError(t.operatorInput.answerRequired);
      return;
    }
    const ok = await dispatchCommand({
      type: "resolve_gate",
      commandId: crypto.randomUUID(),
      runId,
      gateId: primaryGate.gateId,
      gateKind: "operator_input",
      payloadDigest: primaryGate.payloadDigest,
      decision: "answer",
      answer,
    });
    if (ok) {
      setOperatorAnswer("");
      setActiveGateId(null);
    }
  };

  const resolveFixGate = async (command: ResolveGateCommand): Promise<boolean> => {
    const ok = await dispatchCommand(command);
    if (ok) {
      setRevising(false);
      setFeedback("");
      setOperatorAnswer("");
      setActiveGateId(null);
    }
    return ok;
  };

  const loading = !wikiRun.ready && !wikiRun.error;
  const needsOperator = snapshot?.state === "waiting_for_operator" || Boolean(primaryGate);

  const otherRuns = recentRuns.filter((r) => r.runId !== runId).slice(0, 8);

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col gap-2 border-t border-border bg-muted/20 px-2.5 py-2",
        needsOperator && "border-t-primary/40 bg-primary/5",
        className,
      )}
      data-testid="active-run-bar"
      data-run-id={runId}
      data-run-state={snapshot?.state ?? undefined}
      data-graph-open={graphOpen ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-muted/60"
            data-testid="active-run-switcher"
            aria-expanded={runMenuOpen}
            onClick={() => setRunMenuOpen((o) => !o)}
            title={runId}
          >
            <span className="font-mono text-xs font-medium">{shortRunId(runId)}</span>
            {otherRuns.length > 0 ? (
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
          {snapshot?.state ? <StatusBadge status={snapshot.state} /> : null}
          {wikiRun.connectionStatus === "reconnecting" ? (
            <span className="text-2xs text-muted-foreground">
              {t.agentWorkspace.connectionReconnecting}
            </span>
          ) : null}
          {runMenuOpen && otherRuns.length > 0 ? (
            <ul
              className="absolute bottom-full left-0 z-20 mb-1 max-h-48 min-w-[12rem] overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md"
              data-testid="active-run-menu"
            >
              {otherRuns.map((run) => (
                <li key={run.runId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-2xs hover:bg-muted/50"
                    onClick={() => selectRun(run.runId)}
                  >
                    <span className="truncate font-mono">{shortRunId(run.runId)}</span>
                    <Badge variant="outline">{run.state}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          {primaryGate ? (
            <p className="truncate text-xs font-medium" data-testid="active-run-gate-title">
              {gateTitle(primaryGate.kind, t)}
            </p>
          ) : loading ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {t.common.loading}
            </span>
          ) : (
            <p className="truncate text-xs text-muted-foreground">
              {t.agentWorkspace.activeRunIdle}
            </p>
          )}
        </div>

        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="active-run-toggle-graph"
          onClick={() => onGraphOpenChange(!graphOpen)}
        >
          {graphOpen ? (
            <>
              <ChevronUpIcon className="size-3.5" />
              {t.agentWorkspace.collapseGraph}
            </>
          ) : (
            <>
              <ChevronDownIcon className="size-3.5" />
              {t.agentWorkspace.expandGraph}
            </>
          )}
        </Button>
      </div>

      {wikiRun.error ? (
        <p className="text-xs text-destructive" data-testid="active-run-error">
          {wikiRun.error}
        </p>
      ) : null}
      {commandError ? (
        <p className="text-xs text-destructive" data-testid="agent-gate-error">
          {commandError}
        </p>
      ) : null}

      {primaryGate && primaryGate.kind === "fix" ? (
        <FixGatePanel
          gate={primaryGate}
          runId={runId}
          snapshot={snapshot}
          submitting={submitting}
          commandError={commandError}
          onResolve={resolveFixGate}
        />
      ) : primaryGate && primaryGate.kind === "operator_input" ? (
        <div
          className="flex flex-col gap-2"
          data-testid="agent-operator_input-gate"
          data-gate-kind="operator_input"
          data-gate-id={primaryGate.gateId}
        >
          {primaryGate.detail?.summary ? (
            <p
              className="whitespace-pre-wrap text-xs text-muted-foreground"
              data-testid="agent-operator-input-question"
            >
              {primaryGate.detail.summary}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t.operatorInput.questionFallback}</p>
          )}
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="active-run-operator-answer" className="text-xs">
              {t.operatorInput.answerLabel}
            </FieldLabel>
            <Textarea
              id="active-run-operator-answer"
              data-testid="agent-operator-answer"
              value={operatorAnswer}
              onChange={(event) => setOperatorAnswer(event.target.value)}
              placeholder={t.operatorInput.answerPlaceholder}
              disabled={submitting}
              rows={2}
              className="min-h-14 text-xs"
            />
          </div>
          <Button
            type="button"
            size="sm"
            data-testid="agent-operator-answer-submit"
            disabled={submitting || !operatorAnswer.trim()}
            onClick={() => void answerOperatorInput()}
          >
            {submitting ? t.operatorInput.working : t.operatorInput.submit}
          </Button>
        </div>
      ) : primaryGate ? (
        <div
          className="flex flex-col gap-2"
          data-testid={`agent-${primaryGate.kind}-gate`}
          data-gate-kind={primaryGate.kind}
          data-gate-id={primaryGate.gateId}
        >
          {revising && primaryGate.kind === "plan" && activeGateId === primaryGate.gateId ? (
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="active-run-gate-feedback" className="text-xs">
                {t.planConfirm.reviseLabel}
              </FieldLabel>
              <Textarea
                id="active-run-gate-feedback"
                data-testid="agent-gate-feedback"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder={t.planConfirm.revisePlaceholder}
                disabled={submitting}
                rows={2}
                className="min-h-14 text-xs"
              />
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
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
            ) : (
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
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
