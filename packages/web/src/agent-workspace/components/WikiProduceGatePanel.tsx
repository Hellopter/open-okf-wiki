/**
 * wiki_produce panel — durable WikiRuns projection (ADR 0035).
 *
 * Tool details only carry the StartRun receipt (accepted+runId). Live status,
 * open gates, graph chips, and failed-node actions come from useWikiRun
 * (GET + EventSource). Plan/publication HITL uses ResolveGate on the Run API.
 */

import type {
  WikiProduceToolDetails,
  WikiRunAttempt,
  WikiRunGate,
  WikiRunGateKind,
  WikiRunNode,
} from "@okf-wiki/contract";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { dispatchWikiRunCommand } from "../../api";
import { useI18n } from "../../i18n";
import { useWikiRun } from "../hooks/useWikiRun";
import { compactSummary } from "../run-graph/compact-summary";
import { NodeAttemptDialog } from "../run-graph/NodeAttemptDialog";
import { RunGraphCanvas } from "../run-graph/RunGraphCanvas";
import { RunInspectorDialog } from "../run-graph/RunInspectorDialog";
import {
  projectWikiAttempt,
  wikiRunSnapshotToRunGraph,
  wikiRunToViewModel,
} from "../run-graph/wiki-run-view-model";
import { StatusBadge } from "./StatusBadge";

export type WikiProduceGatePanelProps = {
  details: WikiProduceToolDetails;
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}

function gateTitle(kind: WikiRunGateKind, t: ReturnType<typeof useI18n>["t"]): string {
  if (kind === "plan") return t.planConfirm.title;
  if (kind === "publication") return t.runStatus.awaiting_publication;
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
  const graph = useMemo(() => (snapshot ? wikiRunSnapshotToRunGraph(snapshot) : null), [snapshot]);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [commandError, setCommandError] = useState<string | null>(null);
  const [dialogNodeKey, setDialogNodeKey] = useState<string | null>(null);
  const [dialogAttemptId, setDialogAttemptId] = useState<string | null>(null);
  const [activeGateId, setActiveGateId] = useState<string | null>(null);

  useEffect(() => {
    setSubmitting(false);
    setRevising(false);
    setFeedback("");
    setCommandError(null);
    setDialogNodeKey(null);
    setDialogAttemptId(null);
    setActiveGateId(null);
  }, [runId]);

  const openGates = viewModel?.openGates ?? [];
  const primaryGate: WikiRunGate | null =
    openGates.find((g) => g.kind === "plan") ??
    openGates.find((g) => g.kind === "publication") ??
    openGates[0] ??
    null;

  const relatedAttempts = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return [] as ReturnType<typeof projectWikiAttempt>[];
    return snapshot.attempts
      .filter((a) => a.nodeKey === dialogNodeKey)
      .sort((a, b) => a.runIndex - b.runIndex)
      .map(projectWikiAttempt);
  }, [dialogNodeKey, snapshot]);

  const dialogWikiAttempt = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return undefined as WikiRunAttempt | undefined;
    const forNode = snapshot.attempts
      .filter((a) => a.nodeKey === dialogNodeKey)
      .sort((a, b) => a.runIndex - b.runIndex);
    if (dialogAttemptId) {
      return forNode.find((a) => a.attemptId === dialogAttemptId) ?? forNode.at(-1);
    }
    return forNode.at(-1);
  }, [dialogAttemptId, dialogNodeKey, snapshot]);

  const dialogNode: WikiRunNode | undefined = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return undefined;
    return snapshot.nodes.find((n) => n.key === dialogNodeKey);
  }, [dialogNodeKey, snapshot]);

  const dialogAttempt = dialogWikiAttempt ? projectWikiAttempt(dialogWikiAttempt) : undefined;

  const dialogLabel = useMemo(() => {
    if (!dialogNodeKey) return "";
    return dialogNodeKey;
  }, [dialogNodeKey]);

  const openNode = (nodeKey: string) => {
    const latest = snapshot?.attempts
      .filter((a) => a.nodeKey === nodeKey)
      .sort((a, b) => a.runIndex - b.runIndex)
      .at(-1);
    setDialogNodeKey(nodeKey);
    setDialogAttemptId(latest?.attemptId ?? null);
  };

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

  const retryFailed = async (node: WikiRunNode, attempt: WikiRunAttempt) => {
    if (!runId) return;
    await dispatchCommand({
      type: "retry_failed_node",
      commandId: crypto.randomUUID(),
      runId,
      nodeKey: node.key,
      generation: node.generation,
      attemptId: attempt.attemptId,
    });
  };

  const rerunNode = async (node: WikiRunNode) => {
    if (!runId) return;
    await dispatchCommand({
      type: "rerun_node",
      commandId: crypto.randomUUID(),
      runId,
      nodeKey: node.key,
      generation: node.generation,
    });
  };

  const statusLabel = snapshot
    ? snapshot.state
    : details.status === "accepted"
      ? "accepted"
      : details.status;

  const oneLineSummary =
    compactSummary(details.summary, 96) ||
    compactSummary(snapshot ? `rev ${snapshot.revision}` : undefined, 96);

  /** Receipt may still carry historical page paths; live plan text is on Run inspector. */
  const pages = details.pages ?? [];
  const hasGraph =
    Boolean(graph) && ((graph?.topology.length ?? 0) > 0 || (graph?.attempts.length ?? 0) > 0);

  const canRetryDialog =
    dialogNode &&
    dialogWikiAttempt &&
    dialogNode.state === "failed" &&
    (dialogWikiAttempt.state === "failed" || dialogWikiAttempt.state === "interrupted") &&
    dialogWikiAttempt.nodeGeneration === dialogNode.generation;

  const canRerunDialog =
    dialogNode &&
    dialogNode.state !== "cancelled" &&
    dialogNode.state !== "blocked" &&
    runId != null;

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

      {pages.length > 0 ? (
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

      {hasGraph && graph ? (
        <div
          className="flex flex-col gap-1.5 border-t border-border/60 pt-2"
          data-testid="wiki-produce-graph"
        >
          <p className="okf-section-label">
            {t.agentWorkspace.runGraph}
            {graph.attempts.length > 0 ? ` · ${graph.attempts.length}` : null}
          </p>
          <RunGraphCanvas graph={graph} selectedNodeKey={dialogNodeKey} onSelectNode={openNode} />
        </div>
      ) : null}

      {viewModel && viewModel.failedNodes.length > 0 ? (
        <div
          className="flex flex-col gap-1.5 border-t border-border/60 pt-2"
          data-testid="wiki-produce-failed-nodes"
        >
          <p className="okf-section-label">{t.agentWorkspace.failedNodes}</p>
          <ul className="flex flex-col gap-1">
            {viewModel.failedNodes.map(({ node, attempt }) => (
              <li
                key={node.key}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs"
              >
                <button
                  type="button"
                  className="min-w-0 truncate font-medium hover:underline"
                  onClick={() => openNode(node.key)}
                >
                  {node.key}
                </button>
                <span className="flex shrink-0 flex-wrap items-center gap-1">
                  <StatusBadge status={attempt.state} />
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    data-testid="wiki-run-retry-failed"
                    data-node-key={node.key}
                    disabled={submitting}
                    onClick={() => void retryFailed(node, attempt)}
                  >
                    {t.agentWorkspace.retryFailedNode}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-testid="wiki-run-rerun-node"
                    data-node-key={node.key}
                    disabled={submitting}
                    onClick={() => void rerunNode(node)}
                  >
                    {t.agentWorkspace.rerunNode}
                  </Button>
                </span>
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

      <NodeAttemptDialog
        open={dialogNodeKey != null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogNodeKey(null);
            setDialogAttemptId(null);
          }
        }}
        nodeKey={dialogNodeKey ?? ""}
        nodeLabel={dialogLabel}
        attempt={dialogAttempt}
        relatedAttempts={relatedAttempts}
        onSelectAttempt={setDialogAttemptId}
        footer={
          dialogNode && runId ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
              {canRetryDialog && dialogWikiAttempt ? (
                <Button
                  type="button"
                  size="sm"
                  data-testid="wiki-run-dialog-retry"
                  disabled={submitting}
                  onClick={() => void retryFailed(dialogNode, dialogWikiAttempt)}
                >
                  {t.agentWorkspace.retryFailedNode}
                </Button>
              ) : null}
              {canRerunDialog ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="wiki-run-dialog-rerun"
                  disabled={submitting}
                  onClick={() => void rerunNode(dialogNode)}
                >
                  {t.agentWorkspace.rerunNode}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />

      {primaryGate && runId ? (
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
