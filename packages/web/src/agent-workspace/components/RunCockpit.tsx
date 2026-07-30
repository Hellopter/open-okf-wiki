/**
 * Contextual read-only Run observation surface.
 *
 * It consumes the shell's single WikiRun projection. Gate decisions remain in
 * GateAction, so moving this component between a desktop dock, Sheet, and
 * Drawer never creates a second mutation authority.
 */

import type { WikiRunGate, WikiRunSpec } from "@okf-wiki/contract";
import { CircleAlertIcon, CircleCheckIcon, CircleDotIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getWikiRunSpec } from "../../api";
import { useI18n } from "../../i18n";
import { useWikiRunProjection } from "../hooks/WikiRunProjectionContext";
import { selectMatchingProjection } from "../hooks/wiki-run-projection";
import { FailedNodesList } from "../run-graph/FailedNodesList";
import { NodeAttemptDialog } from "../run-graph/NodeAttemptDialog";
import { RunGraphCanvas } from "../run-graph/RunGraphCanvas";
import { useWikiRunNodeActions } from "../run-graph/useWikiRunNodeActions";
import { wikiRunToViewModel } from "../run-graph/wiki-run-view-model";
import { SpecReviewView } from "./SpecReviewView";
import { StatusBadge } from "./StatusBadge";

type RunCockpitTab = "overview" | "plan" | "workflow" | "attempts";

export type RunCockpitProps = {
  workspaceId: string;
  runId: string | null;
  attemptId: string | null;
  onSelectAttempt: (attemptId: string | null) => void;
  /** Closes this presentation host only; it never clears URL `?run=`. */
  onClose?: () => void;
  className?: string;
};

function gateLabel(gate: WikiRunGate, t: ReturnType<typeof useI18n>["t"]): string {
  switch (gate.kind) {
    case "plan":
      return t.planConfirm.title;
    case "publication":
      return t.runStatus.awaiting_publication;
    case "fix":
      return t.fixConfirm.title;
    case "operator_input":
      return t.operatorInput.title;
    default:
      return gate.kind;
  }
}

function connectionLabel(
  status: ReturnType<typeof useWikiRunProjection>["connectionStatus"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (status) {
    case "live":
      return t.agentWorkspace.connectionLive;
    case "reconnecting":
      return t.agentWorkspace.connectionReconnecting;
    case "connecting":
      return t.agentWorkspace.connectionConnecting;
    default:
      return t.agentWorkspace.connectionOffline;
  }
}

function progressForNodes(viewModel: ReturnType<typeof wikiRunToViewModel> | null) {
  if (!viewModel) return null;
  const nodes = viewModel.layers.flatMap((layer) => layer.nodes);
  if (nodes.length === 0) return null;
  const completed = nodes.filter((node) => node.status === "done").length;
  return { completed, total: nodes.length, value: (completed / nodes.length) * 100 };
}

export function RunCockpit({
  workspaceId,
  runId,
  attemptId,
  onSelectAttempt,
  onClose,
  className,
}: RunCockpitProps) {
  const { t } = useI18n();
  const projection = useWikiRunProjection();
  const matched = selectMatchingProjection(projection, runId);
  const snapshot = matched.snapshot;
  const viewModel = useMemo(() => (snapshot ? wikiRunToViewModel(snapshot) : null), [snapshot]);
  const progress = progressForNodes(viewModel);
  const [tab, setTab] = useState<RunCockpitTab>("overview");
  const [planSpec, setPlanSpec] = useState<WikiRunSpec | null>(null);
  const [planSpecLoading, setPlanSpecLoading] = useState(false);
  const [planSpecError, setPlanSpecError] = useState<string | null>(null);

  const actions = useWikiRunNodeActions({
    workspaceId,
    runId,
    snapshot,
  });

  const openNode = (nodeKey: string) => {
    actions.openNode(nodeKey);
    const latest = snapshot?.attempts
      .filter((attempt) => attempt.nodeKey === nodeKey)
      .sort((a, b) => a.runIndex - b.runIndex)
      .at(-1);
    if (latest) onSelectAttempt(latest.attemptId);
  };

  useEffect(() => {
    if (!attemptId || !snapshot) return;
    const attempt = snapshot.attempts.find((item) => item.attemptId === attemptId);
    if (!attempt) return;
    setTab("attempts");
    actions.openNode(attempt.nodeKey);
    actions.setDialogAttemptId(attemptId);
    // Snapshot revision is the durable truth for deep-link restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, snapshot?.revision, runId]);

  useEffect(() => {
    if (!runId || !workspaceId || tab !== "plan") return;
    let cancelled = false;
    setPlanSpecLoading(true);
    setPlanSpecError(null);
    void getWikiRunSpec(workspaceId, runId)
      .then((response) => {
        if (cancelled) return;
        setPlanSpec(response.spec);
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
  }, [runId, snapshot?.revision, tab, workspaceId]);

  if (!runId) return null;

  const loading = !matched.ready && !matched.error;
  const hasWorkflow = Boolean(viewModel && viewModel.layers.length > 0);
  const orderedAttempts = [...(viewModel?.attempts ?? [])].sort((a, b) => b.runIndex - a.runIndex);

  return (
    <section
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}
      data-testid="run-inspector"
      data-run-id={runId}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <CircleDotIcon className="text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.runInspector.title}</span>
        {snapshot?.state ? <StatusBadge status={snapshot.state} /> : null}
        {onClose ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  data-testid="run-inspector-close"
                  onClick={onClose}
                />
              }
            >
              <XIcon data-icon="inline-start" />
              <span className="sr-only">{t.runInspector.close}</span>
            </TooltipTrigger>
            <TooltipContent>{t.runInspector.close}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as RunCockpitTab)}
        className="min-h-0 flex-1"
      >
        <div className="shrink-0 border-b border-border px-3 pt-1">
          <TabsList variant="line" className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="overview">{t.runInspector.overviewTab}</TabsTrigger>
            <TabsTrigger value="plan" data-testid="run-inspector-tab-plan">
              {t.runInspector.planTab}
            </TabsTrigger>
            <TabsTrigger value="workflow" data-testid="run-inspector-tab-graph">
              {t.runInspector.graphTab}
            </TabsTrigger>
            <TabsTrigger value="attempts">{t.runInspector.attemptsTab}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="min-h-0 overflow-y-auto px-3 py-3">
          <ItemGroup className="gap-2">
            <Item variant="outline" size="sm">
              <ItemMedia variant="icon">
                {snapshot?.state === "failed" ? (
                  <CircleAlertIcon aria-hidden />
                ) : (
                  <CircleCheckIcon aria-hidden />
                )}
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="font-mono text-xs">{runId}</ItemTitle>
                <ItemDescription>{connectionLabel(matched.connectionStatus, t)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                {snapshot?.state ? <StatusBadge status={snapshot.state} /> : null}
              </ItemActions>
            </Item>
            {progress ? (
              <Progress
                value={progress.value}
                aria-label={`${progress.completed} / ${progress.total}`}
              >
                <ProgressLabel>{t.runInspector.graphTab}</ProgressLabel>
                <ProgressValue>{() => `${progress.completed} / ${progress.total}`}</ProgressValue>
              </Progress>
            ) : null}
            {viewModel?.openGates.length ? (
              <ItemGroup className="gap-1.5" data-testid="run-inspector-open-gates">
                {viewModel.openGates.map((gate) => (
                  <Item key={gate.gateId} size="xs" variant="muted">
                    <ItemContent>
                      <ItemTitle>{gateLabel(gate, t)}</ItemTitle>
                      {gate.detail?.summary ? (
                        <ItemDescription>{gate.detail.summary}</ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <StatusBadge status={gate.state} />
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : null}
          </ItemGroup>
        </TabsContent>

        <TabsContent value="plan" className="min-h-0 overflow-y-auto px-3 py-3">
          {planSpecLoading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Spinner />
              {t.common.loading}
            </div>
          ) : planSpec ? (
            <Accordion defaultValue={["spec"]}>
              <AccordionItem value="spec">
                <AccordionTrigger>{t.runInspector.planTab}</AccordionTrigger>
                <AccordionContent>
                  <SpecReviewView spec={planSpec} />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : (
            <p className="py-4 text-xs text-muted-foreground" data-testid="run-inspector-no-spec">
              {planSpecError?.trim() || t.runInspector.noSpec}
            </p>
          )}
        </TabsContent>

        <TabsContent value="workflow" className="min-h-0 overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Spinner />
              {t.common.loading}
            </div>
          ) : hasWorkflow && viewModel ? (
            <RunGraphCanvas
              viewModel={viewModel}
              selectedNodeKey={actions.dialogNodeKey}
              onSelectNode={openNode}
            />
          ) : (
            <p className="py-4 text-xs text-muted-foreground">{t.runInspector.noGraph}</p>
          )}
        </TabsContent>

        <TabsContent value="attempts" className="min-h-0 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-3">
            {actions.commandError ? (
              <p className="text-xs text-destructive" data-testid="run-inspector-command-error">
                {actions.commandError}
              </p>
            ) : null}
            <FailedNodesList
              failedNodes={viewModel?.failedNodes ?? []}
              submitting={actions.submitting}
              disabled={!runId}
              onOpenNode={openNode}
              onRetry={(node, attempt) => {
                void actions.retryFailed(node, attempt);
              }}
              onRerun={(node) => {
                void actions.rerunNode(node);
              }}
            />
            {orderedAttempts.length ? (
              <ItemGroup className="gap-1.5">
                {orderedAttempts.map((attempt) => (
                  <Item
                    key={attempt.attemptId}
                    render={<button type="button" />}
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      actions.openNode(attempt.nodeKey);
                      onSelectAttempt(attempt.attemptId);
                    }}
                    data-testid="run-inspector-attempt"
                    data-attempt-id={attempt.attemptId}
                  >
                    <ItemContent>
                      <ItemTitle className="font-mono text-xs">{attempt.nodeKey}</ItemTitle>
                      <ItemDescription>{attempt.summary || attempt.attemptId}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <StatusBadge status={attempt.status} />
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <p className="text-xs text-muted-foreground">{t.runInspector.noAttempts}</p>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <NodeAttemptDialog
        open={actions.dialogNodeKey != null}
        onOpenChange={(open) => {
          if (open) return;
          actions.closeDialog();
          onSelectAttempt(null);
        }}
        nodeKey={actions.dialogNodeKey ?? ""}
        nodeLabel={actions.dialogLabel}
        attempt={actions.dialogAttempt}
        relatedAttempts={actions.relatedAttempts}
        onSelectAttempt={(nextAttemptId) => {
          actions.setDialogAttemptId(nextAttemptId);
          onSelectAttempt(nextAttemptId);
        }}
        workspaceId={workspaceId}
        runId={runId}
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
    </section>
  );
}
