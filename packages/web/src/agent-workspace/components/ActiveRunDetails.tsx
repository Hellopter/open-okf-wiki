/**
 * Inline Run observation panel (plan + graph + retry).
 * Opened from ActiveRunBar; closing does not clear URL `?run=`.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { getWikiRunSpec } from "../../api";
import { useI18n } from "../../i18n";
import {
  selectMatchingProjection,
  useWikiRunProjection,
} from "../hooks/WikiRunProjectionContext";
import { FailedNodesList } from "../run-graph/FailedNodesList";
import { NodeAttemptDialog } from "../run-graph/NodeAttemptDialog";
import { RunGraphCanvas } from "../run-graph/RunGraphCanvas";
import { useWikiRunNodeActions } from "../run-graph/useWikiRunNodeActions";
import { wikiRunToViewModel } from "../run-graph/wiki-run-view-model";
import { selectPrimaryOpenGate } from "./fix-gate";
import { SpecReviewView } from "./SpecReviewView";
import { StatusBadge } from "./StatusBadge";

export type ActiveRunDetailsProps = {
  workspaceId: string;
  rootPath?: string;
  className?: string;
};

export function ActiveRunDetails({ workspaceId, rootPath, className }: ActiveRunDetailsProps) {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get("run");
  const attemptId = searchParams.get("attempt");

  const shellProjection = useWikiRunProjection();
  const matched = selectMatchingProjection(shellProjection, runId);
  const snapshot = matched.snapshot;
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);
  const primaryGate = viewModel ? selectPrimaryOpenGate(viewModel.openGates) : null;

  const [tab, setTab] = useState<"plan" | "graph">("graph");
  const [planSpec, setPlanSpec] = useState<WikiRunSpec | null>(null);
  const [planSpecLoading, setPlanSpecLoading] = useState(false);
  const [planSpecError, setPlanSpecError] = useState<string | null>(null);

  const actions = useWikiRunNodeActions({
    workspaceId,
    rootPath,
    runId,
    snapshot,
  });

  // Prefer plan tab when a plan gate is open.
  useEffect(() => {
    if (primaryGate?.kind === "plan") setTab("plan");
  }, [primaryGate?.kind, primaryGate?.gateId]);

  useEffect(() => {
    if (!attemptId || !snapshot) return;
    const match = snapshot.attempts.find((a) => a.attemptId === attemptId);
    if (match) {
      actions.openNode(match.nodeKey);
      actions.setDialogAttemptId(attemptId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, snapshot?.revision, runId]);

  useEffect(() => {
    if (!runId || !workspaceId || tab !== "plan") return;
    let cancelled = false;
    setPlanSpecLoading(true);
    setPlanSpecError(null);
    void getWikiRunSpec(workspaceId, runId, rootPath)
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
  }, [runId, workspaceId, rootPath, tab, snapshot?.revision]);

  if (!runId) return null;

  const hasGraph = Boolean(
    viewModel && (viewModel.layers.length > 0 || viewModel.attempts.length > 0),
  );
  const loading = !matched.ready && !matched.error;

  const clearAttemptOnly = () => {
    setSearchParams(
      (prev) => {
        if (!prev.has("attempt")) return prev;
        const next = new URLSearchParams(prev);
        next.delete("attempt");
        return next;
      },
      { replace: true },
    );
  };

  return (
    <div
      className={cn(
        "flex max-h-[min(50vh,28rem)] min-h-0 shrink-0 flex-col border-t border-border bg-background",
        className,
      )}
      data-testid="active-run-details"
      data-run-id={runId}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
        <span className="text-xs font-medium">{t.runInspector.title}</span>
        {snapshot?.state ? <StatusBadge status={snapshot.state} /> : null}
        {matched.connectionStatus === "live" ? (
          <span className="text-2xs text-muted-foreground">{t.agentWorkspace.connectionLive}</span>
        ) : matched.connectionStatus === "reconnecting" ? (
          <span className="text-2xs text-muted-foreground">
            {t.agentWorkspace.connectionReconnecting}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={runId}>
          {runId}
        </span>
      </div>

      <div className="shrink-0 border-b border-border px-2.5 pt-1">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "plan" | "graph")}>
          <TabsList variant="line" className="justify-start">
            <TabsTrigger value="plan" data-testid="run-inspector-tab-plan">
              {t.runInspector.planTab}
            </TabsTrigger>
            <TabsTrigger value="graph" data-testid="run-inspector-tab-graph">
              {t.runInspector.graphTab}
              {viewModel && viewModel.attempts.length > 0
                ? ` · ${viewModel.attempts.length}`
                : ""}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-2">
        {matched.error ? (
          <p className="text-xs text-destructive">{matched.error}</p>
        ) : null}
        {actions.commandError ? (
          <p className="text-xs text-destructive" data-testid="run-inspector-command-error">
            {actions.commandError}
          </p>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            {t.common.loading}
          </div>
        ) : tab === "plan" ? (
          planSpecLoading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t.common.loading}
            </div>
          ) : planSpec ? (
            <SpecReviewView spec={planSpec} />
          ) : (
            <p className="py-4 text-xs text-muted-foreground" data-testid="run-inspector-no-spec">
              {planSpecError?.trim() || t.runInspector.noSpec}
            </p>
          )
        ) : hasGraph && viewModel ? (
          <div className="flex flex-col gap-3">
            <RunGraphCanvas
              viewModel={viewModel}
              selectedNodeKey={actions.dialogNodeKey}
              onSelectNode={actions.openNode}
            />
            {viewModel.openGates.length > 0 ? (
              <div data-testid="run-inspector-open-gates" className="flex flex-col gap-1">
                <p className="okf-section-label">{t.agentWorkspace.openGates}</p>
                <ul className="flex flex-col gap-1 text-xs">
                  {viewModel.openGates.map((gate) => (
                    <li
                      key={gate.gateId}
                      className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5"
                    >
                      <span>
                        {gate.kind} · {gate.gateId}
                      </span>
                      <StatusBadge status={gate.state} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <FailedNodesList
              failedNodes={viewModel.failedNodes}
              submitting={actions.submitting}
              disabled={!runId}
              onOpenNode={actions.openNode}
              onRetry={(node, attempt) => {
                void actions.retryFailed(node, attempt);
              }}
              onRerun={(node) => {
                void actions.rerunNode(node);
              }}
            />
          </div>
        ) : (
          <p className="py-4 text-xs text-muted-foreground">{t.runInspector.noGraph}</p>
        )}
      </div>

      <NodeAttemptDialog
        open={actions.dialogNodeKey != null}
        onOpenChange={(o) => {
          if (!o) {
            actions.closeDialog();
            clearAttemptOnly();
          }
        }}
        nodeKey={actions.dialogNodeKey ?? ""}
        nodeLabel={actions.dialogLabel}
        attempt={actions.dialogAttempt}
        relatedAttempts={actions.relatedAttempts}
        onSelectAttempt={actions.setDialogAttemptId}
        workspaceId={workspaceId}
        runId={runId}
        rootPath={rootPath}
        attemptId={actions.dialogWikiAttempt?.attemptId ?? actions.dialogAttemptId}
        attemptState={actions.dialogWikiAttempt?.state ?? null}
        footer={
          actions.dialogNode && runId ? (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
              {actions.canRetryDialog && actions.dialogWikiAttempt ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={actions.submitting}
                  data-testid="run-inspector-dialog-retry"
                  onClick={() =>
                    void actions.retryFailed(actions.dialogNode!, actions.dialogWikiAttempt!)
                  }
                >
                  {t.agentWorkspace.retryFailedNode}
                </Button>
              ) : null}
              {actions.canRerunDialog ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={actions.submitting}
                  data-testid="run-inspector-dialog-rerun"
                  onClick={() => void actions.rerunNode(actions.dialogNode!)}
                >
                  {t.agentWorkspace.rerunNode}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
    </div>
  );
}
