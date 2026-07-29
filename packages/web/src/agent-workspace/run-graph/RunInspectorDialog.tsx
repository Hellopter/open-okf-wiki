/**
 * Post-run / in-flight inspector — durable WikiRuns snapshot (ADR 0035).
 *
 * Live truth: useWikiRun (GET + EventSource). Status and graph come from the
 * snapshot only (no legacy v2 StoredRunRecord list projection).
 */

import type { NodeAttempt, WikiRunAttempt, WikiRunNode } from "@okf-wiki/contract";
import { useMemo, useState } from "react";
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
import { dispatchWikiRunCommand } from "../../api";
import { useI18n } from "../../i18n";
import { StatusBadge } from "../components/StatusBadge";
import { useWikiRun } from "../hooks/useWikiRun";
import { NodeAttemptDialog } from "./NodeAttemptDialog";
import { RunGraphCanvas } from "./RunGraphCanvas";
import {
  projectWikiAttempt,
  wikiRunSnapshotToRunGraph,
  wikiRunToViewModel,
} from "./wiki-run-view-model";

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
  const [dialogNodeKey, setDialogNodeKey] = useState<string | null>(null);
  const [dialogAttemptId, setDialogAttemptId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const wikiRun = useWikiRun({
    workspaceId,
    runId,
    rootPath,
    enabled: open && Boolean(runId),
  });

  const snapshot = wikiRun.snapshot;
  const graph = useMemo(() => (snapshot ? wikiRunSnapshotToRunGraph(snapshot) : null), [snapshot]);
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);

  const relatedAttempts = useMemo(() => {
    if (!dialogNodeKey || !snapshot) return [] as NodeAttempt[];
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
  const dialogLabel = dialogNodeKey ?? "";

  const hasGraph = Boolean(graph && (graph.topology.length > 0 || graph.attempts.length > 0));
  const status = snapshot?.state;
  const loading = open && Boolean(runId) && !wikiRun.ready && !wikiRun.error;

  const dispatch = async (command: Parameters<typeof dispatchWikiRunCommand>[1]) => {
    if (!runId || submitting) return;
    setSubmitting(true);
    setCommandError(null);
    try {
      await dispatchWikiRunCommand(workspaceId, command, rootPath);
      setSubmitting(false);
    } catch (error) {
      setSubmitting(false);
      setCommandError(error instanceof Error ? error.message : String(error));
    }
  };

  const canRetry =
    dialogNode &&
    dialogWikiAttempt &&
    dialogNode.state === "failed" &&
    (dialogWikiAttempt.state === "failed" || dialogWikiAttempt.state === "interrupted") &&
    dialogWikiAttempt.nodeGeneration === dialogNode.generation;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setDialogNodeKey(null);
          setDialogAttemptId(null);
          setCommandError(null);
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
          {commandError ? (
            <p className="text-xs text-destructive" data-testid="run-inspector-command-error">
              {commandError}
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
                {graph && graph.attempts.length > 0 ? ` · ${graph.attempts.length}` : ""}
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
            <p className="py-6 text-xs text-muted-foreground">{t.runInspector.noSpec}</p>
          ) : hasGraph && graph ? (
            <div className="flex flex-col gap-3">
              <RunGraphCanvas
                graph={graph}
                selectedNodeKey={dialogNodeKey}
                onSelectNode={(nodeKey) => {
                  setDialogNodeKey(nodeKey);
                  setDialogAttemptId(null);
                }}
              />
              {viewModel && viewModel.openGates.length > 0 ? (
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
              {viewModel && viewModel.failedNodes.length > 0 ? (
                <div data-testid="run-inspector-failed-nodes" className="flex flex-col gap-1">
                  <p className="okf-section-label">{t.agentWorkspace.failedNodes}</p>
                  <ul className="flex flex-col gap-1">
                    {viewModel.failedNodes.map(({ node, attempt }) => (
                      <li
                        key={node.key}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 px-2 py-1.5 text-xs"
                      >
                        <span className="font-mono">{node.key}</span>
                        <span className="flex gap-1">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={submitting || !runId}
                            data-testid="run-inspector-retry"
                            onClick={() =>
                              void dispatch({
                                type: "retry_failed_node",
                                commandId: crypto.randomUUID(),
                                runId: runId!,
                                nodeKey: node.key,
                                generation: node.generation,
                                attemptId: attempt.attemptId,
                              })
                            }
                          >
                            {t.agentWorkspace.retryFailedNode}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={submitting || !runId}
                            data-testid="run-inspector-rerun"
                            onClick={() =>
                              void dispatch({
                                type: "rerun_node",
                                commandId: crypto.randomUUID(),
                                runId: runId!,
                                nodeKey: node.key,
                                generation: node.generation,
                              })
                            }
                          >
                            {t.agentWorkspace.rerunNode}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="py-6 text-xs text-muted-foreground">{t.runInspector.noGraph}</p>
          )}
        </div>

        <NodeAttemptDialog
          open={dialogNodeKey != null}
          onOpenChange={(o) => {
            if (!o) {
              setDialogNodeKey(null);
              setDialogAttemptId(null);
            }
          }}
          nodeKey={dialogNodeKey ?? ""}
          nodeLabel={dialogLabel}
          attempt={dialogAttempt}
          relatedAttempts={relatedAttempts}
          onSelectAttempt={setDialogAttemptId}
          workspaceId={workspaceId}
          runId={runId}
          rootPath={rootPath}
          attemptId={dialogWikiAttempt?.attemptId ?? dialogAttemptId}
          attemptState={dialogWikiAttempt?.state ?? null}
          footer={
            dialogNode && runId ? (
              <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
                {canRetry && dialogWikiAttempt ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={submitting}
                    data-testid="run-inspector-dialog-retry"
                    onClick={() =>
                      void dispatch({
                        type: "retry_failed_node",
                        commandId: crypto.randomUUID(),
                        runId,
                        nodeKey: dialogNode.key,
                        generation: dialogNode.generation,
                        attemptId: dialogWikiAttempt.attemptId,
                      })
                    }
                  >
                    {t.agentWorkspace.retryFailedNode}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={submitting}
                  data-testid="run-inspector-dialog-rerun"
                  onClick={() =>
                    void dispatch({
                      type: "rerun_node",
                      commandId: crypto.randomUUID(),
                      runId,
                      nodeKey: dialogNode.key,
                      generation: dialogNode.generation,
                    })
                  }
                >
                  {t.agentWorkspace.rerunNode}
                </Button>
              </div>
            ) : null
          }
        />
      </SheetContent>
    </Sheet>
  );
}
