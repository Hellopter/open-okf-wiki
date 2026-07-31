/**
 * Operator Run Cockpit.
 *
 * The durable control-plane projection is organised by what an operator needs
 * to decide: attention first, the actual execution DAG next, and audit detail
 * after that. Gate decisions remain in GateAction; this surface owns only
 * retry, rerun, and one-time evaluation recovery commands.
 */

import type { WikiRunGate, WikiRunSnapshot, WikiRunSpec } from "@okf-wiki/contract";
import {
  CircleAlertIcon,
  CircleDotIcon,
  GitForkIcon,
  HistoryIcon,
  NetworkIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
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

function CandidateLineage({ snapshot }: { snapshot: WikiRunSnapshot }) {
  const { t } = useI18n();
  if (snapshot.candidates.length === 0) return null;

  return (
    <section className="border-t border-border pt-3" data-testid="run-cockpit-candidates">
      <div className="mb-2 flex items-center gap-2">
        <GitForkIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <p className="okf-section-label">{t.agentWorkspace.candidateLineage}</p>
      </div>
      <ol className="flex min-w-0 flex-col gap-2 border-s border-border ps-3">
        {snapshot.candidates.map((candidate) => (
          <li key={candidate.candidateId} className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-mono font-medium">{candidate.candidateId}</span>
              <span className="text-muted-foreground">{candidate.producedBy}</span>
              <span className="text-muted-foreground">#{candidate.round}</span>
            </div>
            {candidate.parentCandidateId ? (
              <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
                {candidate.parentCandidateId}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function RunAttention({
  snapshot,
  viewModel,
  submitting,
  onOpenNode,
  onRetry,
  onRerun,
  onContinueEvaluation,
}: {
  snapshot: WikiRunSnapshot;
  viewModel: ReturnType<typeof wikiRunToViewModel>;
  submitting: boolean;
  onOpenNode: (nodeKey: string) => void;
  onRetry: (
    node: (typeof viewModel.failedNodes)[number]["node"],
    attempt: (typeof viewModel.failedNodes)[number]["attempt"],
  ) => void;
  onRerun: (node: (typeof viewModel.failedNodes)[number]["node"]) => void;
  onContinueEvaluation: (recoveryId: string) => void;
}) {
  const { t } = useI18n();
  const recoveries = snapshot.evaluationRecoveries ?? [];
  const hasAttention =
    recoveries.length > 0 || viewModel.openGates.length > 0 || viewModel.failedNodes.length > 0;

  return (
    <section className="border-b border-border pb-3" data-testid="run-cockpit-attention">
      <div className="mb-2 flex items-center gap-2">
        <CircleAlertIcon
          className={cn("size-3.5", hasAttention ? "text-warning" : "text-muted-foreground")}
          aria-hidden
        />
        <p className="okf-section-label">{t.agentWorkspace.runAttention}</p>
      </div>
      {!hasAttention ? (
        <p className="text-xs text-muted-foreground">{t.agentWorkspace.activeRunIdle}</p>
      ) : null}
      {recoveries.map((recovery) => (
        <Alert
          key={recovery.recoveryId}
          className="mb-2 border-warning/35 bg-warning/5"
          data-testid="run-cockpit-evaluation-recovery"
        >
          <CircleAlertIcon aria-hidden />
          <AlertTitle>{t.agentWorkspace.evaluationRecovery}</AlertTitle>
          <AlertDescription>{recovery.reason}</AlertDescription>
          <div className="col-start-2 mt-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-2xs text-muted-foreground">
              {recovery.candidateId} · {recovery.source}
            </span>
            <Button
              type="button"
              size="xs"
              disabled={submitting}
              data-testid="run-cockpit-continue-evaluation"
              data-recovery-id={recovery.recoveryId}
              onClick={() => onContinueEvaluation(recovery.recoveryId)}
            >
              {t.agentWorkspace.continueEvaluation}
            </Button>
          </div>
        </Alert>
      ))}
      {viewModel.openGates.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-1.5" data-testid="run-inspector-open-gates">
          {viewModel.openGates.map((gate) => (
            <li
              key={gate.gateId}
              className="flex min-w-0 items-center justify-between gap-2 border-s border-primary/40 ps-2 text-xs"
            >
              <span className="min-w-0 truncate">{gateLabel(gate, t)}</span>
              <StatusBadge status={gate.state} />
            </li>
          ))}
        </ul>
      ) : null}
      <FailedNodesList
        failedNodes={viewModel.failedNodes}
        submitting={submitting}
        onOpenNode={onOpenNode}
        onRetry={onRetry}
        onRerun={onRerun}
        className="flex flex-col gap-1"
      />
    </section>
  );
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
  const [planSpec, setPlanSpec] = useState<WikiRunSpec | null>(null);
  const [planSpecLoading, setPlanSpecLoading] = useState(false);
  const [planSpecError, setPlanSpecError] = useState<string | null>(null);

  const actions = useWikiRunNodeActions({ workspaceId, runId, snapshot });

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
    actions.openNode(attempt.nodeKey);
    actions.setDialogAttemptId(attemptId);
    // Snapshot revision is the durable truth for deep-link restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, snapshot?.revision, runId]);

  useEffect(() => {
    if (!runId || !workspaceId) return;
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
  }, [runId, workspaceId]);

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
      <header className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        {matched.error ? (
          <Alert variant="destructive" className="mb-3">
            <CircleAlertIcon aria-hidden />
            <AlertDescription>{matched.error}</AlertDescription>
          </Alert>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Spinner />
            {t.common.loading}
          </div>
        ) : snapshot && viewModel ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <p className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{runId}</p>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  {connectionLabel(matched.connectionStatus, t)}
                </span>
              </div>
              {progress ? (
                <Progress
                  value={progress.value}
                  aria-label={`${progress.completed} / ${progress.total}`}
                >
                  <ProgressLabel>{t.agentWorkspace.runGraph}</ProgressLabel>
                  <ProgressValue>{() => `${progress.completed} / ${progress.total}`}</ProgressValue>
                </Progress>
              ) : null}
            </div>

            <RunAttention
              snapshot={snapshot}
              viewModel={viewModel}
              submitting={actions.submitting}
              onOpenNode={openNode}
              onRetry={(node, attempt) => {
                void actions.retryFailed(node, attempt);
              }}
              onRerun={(node) => {
                void actions.rerunNode(node);
              }}
              onContinueEvaluation={(recoveryId) => {
                void actions.continueEvaluation(recoveryId);
              }}
            />

            {actions.commandError ? (
              <p className="text-xs text-destructive" data-testid="run-inspector-command-error">
                {actions.commandError}
              </p>
            ) : null}

            <section className="min-w-0" data-testid="run-cockpit-dag">
              <div className="mb-2 flex items-center gap-2">
                <NetworkIcon className="size-3.5 text-muted-foreground" aria-hidden />
                <p className="okf-section-label">{t.agentWorkspace.runGraph}</p>
              </div>
              {hasWorkflow ? (
                <RunGraphCanvas
                  viewModel={viewModel}
                  selectedNodeKey={actions.dialogNodeKey}
                  onSelectNode={openNode}
                />
              ) : (
                <p className="text-xs text-muted-foreground">{t.runInspector.noGraph}</p>
              )}
            </section>

            <CandidateLineage snapshot={snapshot} />

            <Accordion defaultValue={[] as string[]} className="border-t border-border">
              <AccordionItem value="attempts">
                <AccordionTrigger data-testid="run-inspector-attempts-toggle">
                  <span className="flex items-center gap-2">
                    <HistoryIcon className="size-3.5 text-muted-foreground" aria-hidden />
                    {t.agentWorkspace.attemptHistory}
                    {orderedAttempts.length ? ` · ${orderedAttempts.length}` : ""}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
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
                            <ItemDescription>
                              {attempt.summary || attempt.attemptId}
                            </ItemDescription>
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
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="plan">
                <AccordionTrigger data-testid="run-inspector-tab-plan">
                  {t.runInspector.planTab}
                </AccordionTrigger>
                <AccordionContent>
                  {planSpecLoading ? (
                    <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                      <Spinner />
                      {t.common.loading}
                    </div>
                  ) : planSpec ? (
                    <SpecReviewView spec={planSpec} />
                  ) : (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="run-inspector-no-spec"
                    >
                      {planSpecError?.trim() || t.runInspector.noSpec}
                    </p>
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        ) : (
          <p className="py-4 text-xs text-muted-foreground">{t.runInspector.noGraph}</p>
        )}
      </div>

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
