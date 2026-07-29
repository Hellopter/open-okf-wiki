/**
 * Post-run / in-flight inspector — durable WikiRuns snapshot (ADR 0035).
 *
 * Live truth: useWikiRun (GET + EventSource). Full control chrome lives here:
 * graph, failed-node retry/rerun, NodeAttemptDialog, plan tab.
 * WikiProduceGatePanel only deep-links here via "View run".
 */

import type { WikiRunSpec } from "@okf-wiki/contract";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getWikiRunSpec } from "../../api";
import { useI18n } from "../../i18n";
import { SpecReviewView } from "../components/SpecReviewView";
import { StatusBadge } from "../components/StatusBadge";
import { useWikiRun } from "../hooks/useWikiRun";
import { FailedNodesList } from "./FailedNodesList";
import { NodeAttemptDialog } from "./NodeAttemptDialog";
import { RunGraphCanvas } from "./RunGraphCanvas";
import { useWikiRunNodeActions } from "./useWikiRunNodeActions";
import { wikiRunToViewModel } from "./wiki-run-view-model";

export type RunInspectorDialogProps = {
  workspaceId: string;
  rootPath?: string;
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function RunInspectorDialog({
  workspaceId,
  rootPath,
  runId,
  open,
  onOpenChange,
}: RunInspectorDialogProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"plan" | "graph">("graph");
  const [planSpec, setPlanSpec] = useState<WikiRunSpec | null>(null);
  const [planSpecLoading, setPlanSpecLoading] = useState(false);
  const [planSpecError, setPlanSpecError] = useState<string | null>(null);

  const wikiRun = useWikiRun({
    workspaceId,
    runId,
    rootPath,
    enabled: open && Boolean(runId),
  });

  const snapshot = wikiRun.snapshot;
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);

  const actions = useWikiRunNodeActions({
    workspaceId,
    rootPath,
    runId,
    snapshot,
  });

  useEffect(() => {
    if (!open || !runId || !workspaceId || tab !== "plan") return;
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
  }, [open, runId, workspaceId, rootPath, tab, snapshot?.revision]);

  const hasGraph = Boolean(
    viewModel && (viewModel.layers.length > 0 || viewModel.attempts.length > 0),
  );
  const status = snapshot?.state;
  const loading = open && Boolean(runId) && !wikiRun.ready && !wikiRun.error;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          actions.closeDialog();
          actions.clearCommandError();
          setTab("graph");
        }
        onOpenChange(next);
      }}
    >
      <SheetContent
        side="right"
        className="flex w-[min(100%,44rem)] flex-col gap-0 p-0 sm:max-w-none"
        data-testid="run-inspector"
      >
        <SheetHeader className="shrink-0 gap-1 border-b border-border px-4 py-3 text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
            {t.runInspector.title}
            {status ? <StatusBadge status={status} /> : null}
            {wikiRun.connectionStatus === "live" ? (
              <span className="text-2xs font-normal text-muted-foreground">
                {t.agentWorkspace.connectionLive}
              </span>
            ) : wikiRun.connectionStatus === "reconnecting" ? (
              <span className="text-2xs font-normal text-muted-foreground">
                {t.agentWorkspace.connectionReconnecting}
              </span>
            ) : null}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span title={runId ?? undefined}>{runId}</span>
            {snapshot?.updatedAt ? (
              <span className="text-muted-foreground/70">
                {new Date(snapshot.updatedAt).toLocaleString()}
              </span>
            ) : null}
          </SheetDescription>
          {wikiRun.error ? <p className="text-xs text-destructive">{wikiRun.error}</p> : null}
          {actions.commandError ? (
            <p className="text-xs text-destructive" data-testid="run-inspector-command-error">
              {actions.commandError}
            </p>
          ) : null}
        </SheetHeader>

        <div className="shrink-0 border-b border-border px-4 pt-1">
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

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t.common.loading}
            </div>
          ) : tab === "plan" ? (
            planSpecLoading ? (
              <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                {t.common.loading}
              </div>
            ) : planSpec ? (
              <SpecReviewView spec={planSpec} />
            ) : (
              <p className="py-6 text-xs text-muted-foreground" data-testid="run-inspector-no-spec">
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
            <p className="py-6 text-xs text-muted-foreground">{t.runInspector.noGraph}</p>
          )}
        </div>

        <NodeAttemptDialog
          open={actions.dialogNodeKey != null}
          onOpenChange={(o) => {
            if (!o) actions.closeDialog();
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
      </SheetContent>
    </Sheet>
  );
}
