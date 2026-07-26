/**
 * Post-run inspector — re-opens a finished (or in-flight) Wiki Run from the
 * durable server state: run record (spec, status, summary) via listRuns and
 * the persisted run graph (analysis/run-graph.json) via getRunGraph.
 *
 * This is what makes runs reviewable after the live wiki_produce stream is
 * gone (page reload, completed run, next day).
 */

import type { NodeAttempt, RunGraphSnapshot, StoredRunRecord } from "@okf-wiki/contract";
import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getRunGraph, listRuns } from "../../api";
import { useI18n } from "../../i18n";
import { SpecReviewView } from "../components/SpecReviewView";
import { StatusBadge } from "../components/StatusBadge";
import { NodeAttemptDialog } from "./NodeAttemptDialog";
import { RunGraphCanvas } from "./RunGraphCanvas";

export type RunInspectorDialogProps = {
  workspaceId: string;
  rootPath?: string;
  runId: string | null;
  /** Known record (e.g. from the Runs panel); fetched by runId when absent. */
  record?: StoredRunRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function RunInspectorDialog({
  workspaceId,
  rootPath,
  runId,
  record,
  open,
  onOpenChange,
}: RunInspectorDialogProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"plan" | "graph">("plan");
  const [loading, setLoading] = useState(false);
  const [fetchedRecord, setFetchedRecord] = useState<StoredRunRecord | null>(null);
  const [graph, setGraph] = useState<RunGraphSnapshot | null>(null);
  const [dialogNodeKey, setDialogNodeKey] = useState<string | null>(null);
  const [dialogAttemptId, setDialogAttemptId] = useState<string | null>(null);

  const run = record ?? fetchedRecord;

  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    setLoading(true);
    setGraph(null);
    setFetchedRecord(null);
    setTab("plan");
    setDialogNodeKey(null);
    setDialogAttemptId(null);
    (async () => {
      const [graphResult, recordResult] = await Promise.allSettled([
        getRunGraph(workspaceId, runId, rootPath),
        record ? Promise.resolve(null) : listRuns(workspaceId, rootPath),
      ]);
      if (cancelled) return;
      if (graphResult.status === "fulfilled") {
        setGraph(graphResult.value.graph);
      }
      if (recordResult.status === "fulfilled" && recordResult.value) {
        setFetchedRecord(recordResult.value.runs.find((r) => r.runId === runId) ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, runId, workspaceId, rootPath, record]);

  const attempts = useMemo(() => graph?.attempts ?? [], [graph]);
  const relatedAttempts = useMemo(() => {
    if (!dialogNodeKey) return [] as NodeAttempt[];
    return attempts
      .filter((a) => a.nodeKey === dialogNodeKey)
      .sort((a, b) => a.runIndex - b.runIndex);
  }, [attempts, dialogNodeKey]);
  const dialogAttempt = useMemo(() => {
    if (dialogAttemptId) {
      return relatedAttempts.find((a) => a.attemptId === dialogAttemptId) ?? relatedAttempts.at(-1);
    }
    return relatedAttempts.at(-1);
  }, [dialogAttemptId, relatedAttempts]);
  const dialogLabel = useMemo(() => {
    if (!dialogNodeKey) return "";
    const fromTopo = graph?.topology.find((n) => n.nodeKey === dialogNodeKey)?.label;
    return fromTopo ?? dialogAttempt?.role ?? dialogNodeKey;
  }, [graph?.topology, dialogAttempt?.role, dialogNodeKey]);

  const hasGraph = Boolean(graph && (graph.topology.length > 0 || graph.attempts.length > 0));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[min(100%,44rem)] flex-col gap-0 p-0 sm:max-w-none"
        data-testid="run-inspector"
      >
        <SheetHeader className="shrink-0 gap-1 border-b border-border px-4 py-3 text-left">
          <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
            {t.runInspector.title}
            {run ? <StatusBadge status={run.status} /> : null}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span title={runId ?? undefined}>{runId}</span>
            {run?.updatedAt ? (
              <span className="text-muted-foreground/70">
                {new Date(run.updatedAt).toLocaleString()}
              </span>
            ) : null}
          </SheetDescription>
          {run?.summary ? (
            <p className="text-xs text-muted-foreground">{run.summary}</p>
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
                {attempts.length > 0 ? ` · ${attempts.length}` : ""}
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
            run?.spec ? (
              <SpecReviewView spec={run.spec} />
            ) : (
              <p className="py-6 text-xs text-muted-foreground">{t.runInspector.noSpec}</p>
            )
          ) : hasGraph && graph ? (
            <RunGraphCanvas
              graph={graph}
              selectedNodeKey={dialogNodeKey}
              onSelectNode={(nodeKey) => {
                setDialogNodeKey(nodeKey);
                setDialogAttemptId(null);
              }}
            />
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
        />
      </SheetContent>
    </Sheet>
  );
}
