import type { AttemptTraceEvent, RunCommand, WikiRunAttempt, WikiRunNode, WikiRunPlanReview, WikiRunSnapshot, WikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import {
  ArrowLeftIcon,
  Clock3Icon,
  LoaderCircleIcon,
  RotateCcwIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AttemptContextSummary,
  attemptToolToViewModel,
  CodeSurface,
  describeAttemptStatus,
  describeNodeStatus,
  isCapacityFailure,
  StatusBadge,
  ToolChipRow,
} from "@/components/agent-ui";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PlanDocument, SpecSections } from "./plan-review/PlanDocument";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { MessageTree } from "../i18n";
import { newCommandId } from "../lib/command-id";
import { MarkdownDocument } from "../shared/MarkdownDocument";
import {
  canRerunNode,
  canRetryFailedNode,
  isPlanSufficiencyGapRetry,
  lastFailedAttemptForNode,
  shouldShowNoAutoRetryHint,
  truncateAttemptError,
} from "./node-recovery";
import type { FollowMode } from "./observation-state";
import {
  type PlanScoutDisplay,
  planScoutKindFromKey,
  planScoutSlug,
} from "./workflow-topology";

/** Compact preview length for attempt-history sidebar rows. */
const HISTORY_ERROR_PREVIEW_CHARS = 96;

function elapsed(attempt: WikiRunAttempt): string | null {
  const end = attempt.endedAt ? new Date(attempt.endedAt).getTime() : Date.now();
  const start = new Date(attempt.startedAt).getTime();
  if (!Number.isFinite(start) || end < start) return null;
  const seconds = Math.round((end - start) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function attemptStateLabel(state: string, t: MessageTree): string {
  return (
    t.workbench.nodeStates[state as keyof typeof t.workbench.nodeStates] ??
    state.replaceAll("_", " ")
  );
}

type ToolCallEvent = Extract<AttemptTraceEvent, { kind: "tool_call" }>;
type ToolResultEvent = Extract<AttemptTraceEvent, { kind: "tool_result" }>;
type ActivityEntry =
  | { kind: "tool"; call?: ToolCallEvent; result?: ToolResultEvent }
  | { kind: "event"; event: Exclude<AttemptTraceEvent, ToolCallEvent | ToolResultEvent> };

function ActivityFeed({
  trace,
  t,
  followMode,
}: {
  trace: AttemptTraceEvent[];
  t: MessageTree;
  followMode: FollowMode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rendered = useMemo<ActivityEntry[]>(() => {
    const pairedResults = new Set<number>();
    const entries: ActivityEntry[] = [];
    for (const event of trace) {
      if (event.kind === "tool_call") {
        const result = trace.find(
          (candidate) =>
            candidate.kind === "tool_result" &&
            candidate.ordinal > event.ordinal &&
            candidate.toolCallId &&
            candidate.toolCallId === event.toolCallId,
        ) as Extract<AttemptTraceEvent, { kind: "tool_result" }> | undefined;
        if (result) pairedResults.add(result.ordinal);
        entries.push({ kind: "tool", call: event, result });
        continue;
      }
      if (event.kind === "tool_result") {
        if (!pairedResults.has(event.ordinal)) entries.push({ kind: "tool", result: event });
        continue;
      }
      entries.push({ kind: "event", event });
    }
    return entries;
  }, [trace]);

  useEffect(() => {
    if (followMode !== "selected-live") return;
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [followMode, rendered.length]);

  if (trace.length === 0)
    return <p className="py-12 text-center text-sm text-muted-foreground">{t.workbench.noTrace}</p>;
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-4 py-5 md:px-6">
        {rendered.map((item) => {
          if (item.kind === "tool") {
            const vm = attemptToolToViewModel(item.call, item.result, {
              wikiProduce: t.workbench.toolNames.wiki_produce,
              status: {
                pending: t.workbench.toolPending,
                running: t.workbench.toolRunning,
                done: t.workbench.toolCompleted,
                error: t.workbench.toolFailed,
              },
            });
            return (
              <ToolChipRow
                key={item.call?.ordinal ?? item.result?.ordinal}
                item={vm}
                openRunLabel={t.workbench.openRun}
                inputLabel={t.workbench.rawInput}
                outputLabel={t.workbench.rawOutput}
                errorLabel={t.workbench.toolError}
              />
            );
          }
          const event = item.event;
          if (event.kind === "input") {
            return (
              <Collapsible key={event.ordinal} className="min-w-0" defaultOpen={false}>
                <CollapsibleTrigger className="-mx-1 flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {t.workbench.attemptInput}
                  </span>
                  <time className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {new Date(event.at).toLocaleTimeString()}
                  </time>
                </CollapsibleTrigger>
                <CollapsibleContent className="min-w-0 overflow-hidden">
                  <div className="mt-1 mb-1 ml-2 border-l border-border pl-3.5">
                    <CodeSurface
                      value={event.content}
                      maxHeightClass="max-h-[36rem]"
                      copyable
                      copyLabel={t.workbench.copy}
                      copiedLabel={t.workbench.copied}
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          }
          if (event.kind === "assistant") {
            return (
              <article key={event.ordinal} className="group/attempt-assistant space-y-1.5">
                <time className="block font-mono text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/attempt-assistant:opacity-100 group-focus-within/attempt-assistant:opacity-100">
                  {new Date(event.at).toLocaleTimeString()}
                </time>
                <MarkdownDocument content={event.content} />
              </article>
            );
          }
          if (event.kind === "terminal") {
            const status =
              event.status === "error"
                ? t.workbench.toolFailed
                : event.status === "cancelled"
                  ? t.workbench.nodeStates.cancelled
                  : t.workbench.toolCompleted;
            return (
              <Alert
                key={event.ordinal}
                variant={event.status === "error" ? "destructive" : "default"}
              >
                <TerminalIcon />
                <AlertTitle>{status}</AlertTitle>
                <AlertDescription>{event.summary}</AlertDescription>
              </Alert>
            );
          }
          return (
            <Alert key={event.ordinal}>
              <TerminalIcon />
              <AlertTitle>{t.workbench.traceKinds.truncated}</AlertTitle>
              <AlertDescription>
                {event.reason}: {event.limitBytes}
              </AlertDescription>
            </Alert>
          );
        })}
      </div>
    </div>
  );
}

/** Plan tab body with load/error states from the shared plan-review owner. */
export function RunPlanDetails({
  spec,
  planReview,
  planReviewStatus = "idle",
  planReviewRetry,
  t,
}: {
  spec: WikiRunSpec | null;
  planReview?: WikiRunPlanReview | null;
  planReviewStatus?: import("./plan-review/plan-review-utils").PlanReviewStatus;
  planReviewRetry?: () => void;
  t: MessageTree;
}) {
  if (planReviewStatus === "loading" || planReviewStatus === "stale") {
    return (
      <p
        className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-muted-foreground"
        data-testid="plan-review-loading"
      >
        <LoaderCircleIcon className="size-4 animate-spin" />
        {planReviewStatus === "stale" ? t.specReview.refreshing : t.specReview.loading}
      </p>
    );
  }
  if (planReviewStatus === "error") {
    return (
      <div className="space-y-3 px-4 py-12 text-center" data-testid="plan-review-error">
        <p className="text-sm text-destructive">{t.specReview.loadError}</p>
        {planReviewRetry ? (
          <Button size="sm" variant="outline" onClick={planReviewRetry}>
            {t.specReview.retry}
          </Button>
        ) : null}
      </div>
    );
  }
  if (planReview) {
    return (
      <div className="px-4 py-5 md:px-6">
        <PlanDocument review={planReview} t={t} />
      </div>
    );
  }
  if (!spec)
    return (
      <p className="px-4 py-12 text-center text-sm text-muted-foreground">
        {t.workbench.planPending}
      </p>
    );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-5 md:px-6">
      <SpecSections spec={spec} t={t} />
    </div>
  );
}

function PlanScoutObservation({
  selectedNode,
  scout,
  siblingScouts,
  onBack,
  onOpenPlan,
  t,
}: {
  selectedNode: WikiRunNode;
  scout: PlanScoutDisplay | undefined;
  siblingScouts: PlanScoutDisplay[];
  onBack: () => void;
  onOpenPlan?: () => void;
  t: MessageTree;
}) {
  const kind = scout?.kind ?? planScoutKindFromKey(selectedNode.key);
  const stateLabel =
    t.workbench.nodeStates[selectedNode.state as keyof typeof t.workbench.nodeStates] ??
    selectedNode.state;
  const statusDescriptor = describeNodeStatus(selectedNode.state);
  const preview = scout?.preview?.trim() ?? "";
  const relPath = scout?.relPath ?? selectedNode.detail?.scope;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="plan-scout-observation">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            {t.workbench.backToGraph}
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {selectedNode.label || `${t.workbench.planScout} · ${kind}`}
            </p>
            <p className="font-mono text-xs text-muted-foreground">{selectedNode.key}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge descriptor={statusDescriptor}>{stateLabel}</StatusBadge>
          {scout?.ok === false ? (
            <Badge variant="destructive">{t.workbench.planScoutFailed}</Badge>
          ) : scout?.ok === true ? (
            <Badge variant="secondary">{t.workbench.planScoutOk}</Badge>
          ) : null}
          {onOpenPlan ? (
            <Button size="sm" variant="outline" onClick={onOpenPlan} data-testid="open-plan-node">
              {t.workbench.openPlanNode}
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t.workbench.planScoutReceipt}</h2>
            {relPath ? (
              <p className="font-mono text-xs text-muted-foreground">{relPath}</p>
            ) : null}
            {preview ? (
              <div
                className="rounded-lg border border-border bg-card p-4"
                data-testid="plan-scout-preview"
              >
                <MarkdownDocument content={preview} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t.workbench.planScoutNoReceipt}</p>
            )}
          </section>
          {siblingScouts.length > 1 ? (
            <section className="space-y-2" data-testid="plan-scout-siblings">
              <h3 className="text-sm font-medium">{t.workbench.planScoutSiblings}</h3>
              <div className="flex flex-wrap gap-1.5">
                {siblingScouts.map((item) => (
                  <Badge
                    key={item.kind}
                    variant={planScoutSlug(item.kind) === planScoutSlug(kind) ? "default" : "outline"}
                  >
                    {item.kind}
                    {item.ok === false ? " · !" : ""}
                  </Badge>
                ))}
              </div>
            </section>
          ) : null}
          <p className="text-xs text-muted-foreground">{t.workbench.planScoutVirtualHint}</p>
        </div>
      </div>
    </div>
  );
}

export function AttemptObservation({
  snapshot,
  selectedNode,
  selectedAttempt,
  trace,
  spec,
  planReview = null,
  planReviewStatus = "idle",
  planReviewRetry,
  planScoutDisplays = [],
  onBack,
  onSelectAttempt,
  onSelectNode,
  onLoadEarlier,
  canLoadEarlier,
  loadingEarlier,
  followMode,
  onFollowModeChange,
  onRunCommand,
  t,
}: {
  snapshot: WikiRunSnapshot;
  selectedNode: WikiRunNode | null;
  selectedAttempt: WikiRunAttempt | null;
  trace: AttemptTraceEvent[];
  spec: WikiRunSpec | null;
  planReview?: WikiRunPlanReview | null;
  planReviewStatus?: import("./plan-review/plan-review-utils").PlanReviewStatus;
  planReviewRetry?: () => void;
  /** Merged scout displays for virtual plan.scout observation. */
  planScoutDisplays?: PlanScoutDisplay[];
  onBack: () => void;
  onSelectAttempt: (attempt: WikiRunAttempt) => void;
  /** Select another graph node (used by virtual scout → open plan). */
  onSelectNode?: (nodeKey: string) => void;
  onLoadEarlier: () => void;
  canLoadEarlier: boolean;
  loadingEarlier: boolean;
  followMode: FollowMode;
  onFollowModeChange: (mode: FollowMode) => void;
  /** Dispatch a typed Run command using the latest snapshot + revision. */
  onRunCommand?: (build: (latest: WikiRunSnapshot) => RunCommand) => void;
  t: MessageTree;
}) {
  const [rerunFeedback, setRerunFeedback] = useState("");
  const [confirmRerunOpen, setConfirmRerunOpen] = useState(false);

  const isPlanScoutNode =
    selectedNode?.kind === "plan.scout" ||
    Boolean(selectedNode?.key.startsWith("plan.scout."));

  const attempts = selectedNode
    ? snapshot.attempts
        .filter((attempt) => attempt.nodeKey === selectedNode.key)
        .slice()
        .sort(
          (left, right) =>
            right.nodeGeneration - left.nodeGeneration || right.runIndex - left.runIndex,
        )
    : [];

  const scoutDisplay = useMemo((): PlanScoutDisplay | undefined => {
    if (!selectedNode || !isPlanScoutNode) return undefined;
    const slug = planScoutKindFromKey(selectedNode.key);
    return (
      planScoutDisplays.find((item) => planScoutSlug(item.kind) === slug) ??
      planReview?.scoutsSummary?.scouts?.find((item) => planScoutSlug(item.kind) === slug)
    );
  }, [selectedNode, isPlanScoutNode, planScoutDisplays, planReview?.scoutsSummary?.scouts]);

  // Legacy display-only scouts (no durable Attempt): receipt markdown panel.
  // Durable plan.scout with attempts uses the standard transcript path below.
  if (isPlanScoutNode && selectedNode && attempts.length === 0 && !selectedAttempt) {
    const siblings =
      planScoutDisplays.length > 0
        ? planScoutDisplays
        : (planReview?.scoutsSummary?.scouts ??
          planReview?.scoutsSummary?.kinds?.map((kind) => ({ kind })) ??
          []);
    return (
      <PlanScoutObservation
        selectedNode={selectedNode}
        scout={scoutDisplay}
        siblingScouts={siblings}
        onBack={onBack}
        onOpenPlan={onSelectNode ? () => onSelectNode("plan") : undefined}
        t={t}
      />
    );
  }

  const live = selectedAttempt?.state === "running" || selectedAttempt?.state === "suspended";
  const scoutReceiptPreview = scoutDisplay?.preview?.trim() ?? "";

  const retry = selectedNode ? canRetryFailedNode(snapshot, selectedNode.key) : null;
  const rerun = selectedNode ? canRerunNode(snapshot, selectedNode.key) : null;
  const showRecovery = Boolean(onRunCommand && selectedNode && (retry || rerun));

  const showAttemptErrorAlert = Boolean(
    selectedAttempt &&
      ["failed", "interrupted"].includes(selectedAttempt.state) &&
      selectedAttempt.error != null &&
      selectedAttempt.error.length > 0,
  );
  const capacityFailure = Boolean(
    selectedAttempt &&
      isCapacityFailure(selectedAttempt.failureClass, selectedAttempt.error),
  );
  const showNoAutoRetry =
    showAttemptErrorAlert &&
    shouldShowNoAutoRetryHint(selectedAttempt?.failureClass, selectedNode?.kind);

  const attemptContextLabels = {
    modelAria: t.workbench.context.modelAria,
    meterAria: t.workbench.context.meterAria,
    in: t.workbench.context.inTokens,
    out: t.workbench.context.outTokens,
    tools: t.workbench.context.toolCalls,
  };

  // Plan coverage/semantic gap → host re-discover label (not same-digest Retry).
  // Prefer the node's last failed attempt (retry target), not a historical row.
  const planSufficiencyRetry = Boolean(
    selectedNode &&
      isPlanSufficiencyGapRetry(
        selectedNode.key,
        lastFailedAttemptForNode(snapshot, selectedNode.key) ??
          (selectedAttempt && ["failed", "interrupted"].includes(selectedAttempt.state)
            ? selectedAttempt
            : null),
      ),
  );
  const retryLabel = planSufficiencyRetry
    ? t.workbench.retryNodeRediscover
    : t.workbench.retryNode;
  const retryTitle =
    retry?.ok === false
      ? (t.workbench.cannotRetryReason[retry.reasonKey] ?? t.workbench.retryNodeHint)
      : planSufficiencyRetry
        ? t.workbench.retryNodeRediscoverHint
        : t.workbench.retryNodeHint;
  const rerunTitle =
    rerun?.ok === false
      ? (t.workbench.cannotRerunReason[rerun.reasonKey] ?? t.workbench.rerunNodeHint)
      : t.workbench.rerunNodeHint;

  const dispatchRetry = () => {
    if (!onRunCommand || !selectedNode || retry?.ok !== true) return;
    const nodeKey = selectedNode.key;
    onRunCommand((latest) => {
      const fresh = canRetryFailedNode(latest, nodeKey);
      if (fresh.ok !== true) {
        throw new Error(
          t.workbench.cannotRetryReason[fresh.reasonKey] ?? t.workbench.retryNodeHint,
        );
      }
      return {
        type: "retry_failed_node",
        commandId: newCommandId(),
        runId: latest.runId,
        expectedRevision: latest.revision,
        nodeKey,
        generation: fresh.generation,
        attemptId: fresh.attemptId,
      };
    });
  };

  const dispatchRerun = () => {
    if (!onRunCommand || !selectedNode || rerun?.ok !== true) return;
    const nodeKey = selectedNode.key;
    const feedback = rerunFeedback.trim();
    onRunCommand((latest) => {
      const fresh = canRerunNode(latest, nodeKey);
      if (fresh.ok !== true) {
        throw new Error(
          t.workbench.cannotRerunReason[fresh.reasonKey] ?? t.workbench.rerunNodeHint,
        );
      }
      return {
        type: "rerun_node",
        commandId: newCommandId(),
        runId: latest.runId,
        expectedRevision: latest.revision,
        nodeKey,
        generation: fresh.generation,
        ...(feedback ? { feedback } : {}),
      };
    });
    setRerunFeedback("");
    setConfirmRerunOpen(false);
  };

  const requestRerun = () => {
    if (!rerun?.ok) return;
    // Always confirm rerun — it bumps generation and may invalidate consumers.
    setConfirmRerunOpen(true);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="attempt-observation">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            {t.workbench.backToGraph}
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {selectedNode?.label ?? t.workbench.attempts}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {selectedAttempt?.attemptId ?? selectedNode?.key ?? ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedAttempt ? (
            <AttemptContextSummary
              attempt={selectedAttempt}
              labels={attemptContextLabels}
              className="mr-1"
            />
          ) : null}
          {showRecovery ? (
            <div className="flex flex-wrap items-center gap-1" data-testid="node-recovery-actions">
              <Button
                size="sm"
                variant={retry?.ok ? "default" : "outline"}
                disabled={!retry?.ok}
                title={retryTitle}
                aria-label={retryLabel}
                data-testid="retry-node"
                data-rediscover={planSufficiencyRetry ? "true" : undefined}
                onClick={dispatchRetry}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {retryLabel}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!rerun?.ok}
                title={rerunTitle}
                aria-label={t.workbench.rerunNode}
                data-testid="rerun-node"
                onClick={requestRerun}
              >
                {t.workbench.rerunNode}
              </Button>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={followMode === "selected-live"}
              disabled={!live}
              onCheckedChange={(checked) =>
                onFollowModeChange(checked ? "selected-live" : "pinned")
              }
            />
            {t.workbench.followLive}
          </label>
        </div>
      </header>
      {showRecovery && rerun?.ok ? (
        <div className="border-b border-border px-4 py-2 md:px-6">
          <Textarea
            className="min-h-16 max-w-xl"
            value={rerunFeedback}
            onChange={(event) => setRerunFeedback(event.target.value)}
            placeholder={t.workbench.rerunFeedbackPlaceholder}
            aria-label={t.workbench.rerunFeedbackPlaceholder}
            data-testid="rerun-feedback"
          />
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmRerunOpen}
        onOpenChange={setConfirmRerunOpen}
        title={t.workbench.rerunNodeConfirmTitle}
        description={
          rerun?.ok && rerun.warnConsumers
            ? t.workbench.rerunNodeConfirmConsumers
            : t.workbench.rerunNodeConfirm
        }
        confirmLabel={t.workbench.rerunNode}
        onConfirm={dispatchRerun}
        destructive={Boolean(rerun?.ok && rerun.warnConsumers)}
        data-testid="rerun-confirm-dialog"
        confirmTestId="rerun-confirm"
      />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-border bg-muted/15 md:w-64 md:border-r md:border-b-0">
          <div className="flex items-center gap-2 px-4 py-3 text-xs font-medium text-muted-foreground">
            <Clock3Icon className="size-3.5" />
            {t.workbench.attemptHistory}
          </div>
          <div className="flex max-h-40 gap-2 overflow-x-auto px-2 pb-2 md:max-h-none md:flex-col md:overflow-y-auto md:px-2">
            {attempts.map((attempt) => {
              const failedish =
                attempt.state === "failed" || attempt.state === "interrupted";
              const capacity = isCapacityFailure(attempt.failureClass, attempt.error);
              const failureLabel =
                failedish && attempt.failureClass
                  ? capacity
                    ? t.workbench.capacityFailureTitle
                    : attempt.failureClass
                  : null;
              const historyMeta = [elapsed(attempt), failureLabel].filter(Boolean).join(" · ");
              const historyError =
                failedish && attempt.error
                  ? truncateAttemptError(attempt.error, HISTORY_ERROR_PREVIEW_CHARS)
                  : null;
              return (
                <Button
                  key={attempt.attemptId}
                  size="sm"
                  variant={
                    attempt.attemptId === selectedAttempt?.attemptId ? "secondary" : "ghost"
                  }
                  className="h-auto min-w-48 shrink-0 justify-start px-3 py-2 text-left md:min-w-0"
                  onClick={() => onSelectAttempt(attempt)}
                  title={historyError ?? undefined}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">
                      #{attempt.nodeGeneration} · {attempt.runIndex}
                    </span>
                    {historyMeta ? (
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {historyMeta}
                      </span>
                    ) : null}
                    <AttemptContextSummary
                      attempt={attempt}
                      labels={attemptContextLabels}
                      compact
                      className="mt-1"
                      data-testid="attempt-history-context"
                    />
                    {historyError ? (
                      <span
                        className="mt-0.5 block line-clamp-2 text-[11px] text-destructive/90"
                        data-testid="attempt-history-error"
                      >
                        {historyError}
                      </span>
                    ) : null}
                  </span>
                  <StatusBadge descriptor={describeAttemptStatus(attempt.state)}>
                    {attemptStateLabel(attempt.state, t)}
                  </StatusBadge>
                </Button>
              );
            })}
            {attempts.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {t.workbench.noAttemptStarted}
              </p>
            ) : null}
          </div>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Tabs defaultValue="activity" className="flex min-h-0 flex-1 flex-col">
            <TabsList variant="line" className="shrink-0 border-b border-border px-4 md:px-6">
              <TabsTrigger value="activity">{t.workbench.nodeActivity}</TabsTrigger>
              {scoutReceiptPreview ? (
                <TabsTrigger value="receipt" data-testid="plan-scout-receipt-tab">
                  {t.workbench.planScoutReceipt}
                </TabsTrigger>
              ) : null}
              <TabsTrigger value="plan">{t.workbench.plan}</TabsTrigger>
              <TabsTrigger value="events">{t.workbench.rawEvents}</TabsTrigger>
            </TabsList>
            <TabsContent value="activity" className="min-h-0 flex-1 overflow-hidden">
              {selectedAttempt ? (
                <div className="flex h-full min-h-0 flex-col">
                  {showAttemptErrorAlert ? (
                    <Alert
                      variant="destructive"
                      className="sticky top-0 z-10 shrink-0 rounded-none border-x-0 border-t-0"
                      data-testid="attempt-error-alert"
                    >
                      <TriangleAlertIcon />
                      <AlertTitle>
                        {capacityFailure
                          ? t.workbench.capacityFailureTitle
                          : selectedAttempt.failureClass
                            ? `${t.workbench.attemptErrorTitle} · ${selectedAttempt.failureClass}`
                            : t.workbench.attemptErrorTitle}
                      </AlertTitle>
                      <AlertDescription className="whitespace-pre-wrap break-words font-mono text-xs">
                        {selectedAttempt.error}
                      </AlertDescription>
                      {capacityFailure ? (
                        <p
                          className="col-start-2 mt-1 text-xs text-muted-foreground"
                          data-testid="attempt-capacity-hint"
                        >
                          {t.workbench.capacityFailureHint}
                        </p>
                      ) : null}
                      {showNoAutoRetry ? (
                        <p
                          className="col-start-2 mt-1 text-xs text-muted-foreground"
                          data-testid="attempt-no-auto-retry-hint"
                        >
                          {t.workbench.noAutoRetryHint}
                        </p>
                      ) : null}
                    </Alert>
                  ) : null}
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <ActivityFeed trace={trace} t={t} followMode={followMode} />
                  </div>
                </div>
              ) : (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {t.workbench.noAttemptStarted}
                </p>
              )}
            </TabsContent>
            {scoutReceiptPreview ? (
              <TabsContent value="receipt" className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-5 md:px-6">
                  {scoutDisplay?.relPath ? (
                    <p className="font-mono text-xs text-muted-foreground">{scoutDisplay.relPath}</p>
                  ) : null}
                  <div
                    className="rounded-lg border border-border bg-card p-4"
                    data-testid="plan-scout-preview"
                  >
                    <MarkdownDocument content={scoutReceiptPreview} />
                  </div>
                </div>
              </TabsContent>
            ) : null}
            <TabsContent value="plan" className="min-h-0 flex-1 overflow-y-auto">
              <RunPlanDetails
                spec={spec}
                planReview={planReview}
                planReviewStatus={planReviewStatus}
                planReviewRetry={planReviewRetry}
                t={t}
              />
            </TabsContent>
            <TabsContent value="events" className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-5 md:px-6">
                {canLoadEarlier ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    disabled={loadingEarlier}
                    onClick={onLoadEarlier}
                  >
                    {loadingEarlier ? <LoaderCircleIcon className="animate-spin" /> : null}
                    {t.workbench.loadEarlier}
                  </Button>
                ) : null}
                {trace.map((event) => (
                  <CodeSurface
                    key={event.ordinal}
                    value={JSON.stringify(event, null, 2)}
                    maxHeightClass="max-h-[34rem]"
                    copyable
                    copyLabel={t.workbench.copy}
                    copiedLabel={t.workbench.copied}
                  />
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </section>
      </div>
    </div>
  );
}
