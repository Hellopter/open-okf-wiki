/**
 * Popup for a single run-graph node's attempt(s).
 *
 * Attempt transcript:
 * - completed → GET …/transcript (one-shot render)
 * - running/suspended → EventSource …/transcript/events (live snapshots)
 * Not Session SSE; not Run control SSE.
 *
 * Display surfaces (no dual trail):
 * - summary → AgentMarkdown
 * - transcript → TranscriptMessageList (projects tool rows via shared chrome)
 *
 * Scroll: flex column shell + native overflow-y body.
 */

import type { AttemptTraceEvent, NodeAttempt } from "@okf-wiki/contract";
import { ChevronUpIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ApiError,
  getWikiRunAttemptTranscript,
  wikiRunAttemptTranscriptEventsUrl,
} from "../../api";
import { useI18n } from "../../i18n";
import { AgentMarkdown } from "../transcript/AgentMarkdown";
import { TranscriptMessage } from "../transcript/Transcript";
import { isAttemptTranscriptLive, projectAttemptTranscriptMessages } from "./attempt-transcript";

export type NodeAttemptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeLabel: string;
  nodeKey: string;
  attempt: NodeAttempt | null | undefined;
  relatedAttempts?: NodeAttempt[];
  onSelectAttempt?: (attemptId: string) => void;
  /** Optional action row (RetryFailedNode / RerunNode) under the scroll body. */
  footer?: ReactNode;
  /** Workspace / run context for Attempt transcript fetch. */
  workspaceId?: string;
  runId?: string | null;
  /** Explicit attempt id (preferred over attempt.attemptId when set). */
  attemptId?: string | null;
  /** WikiRunAttempt.state (or equivalent); drives live polling while `running`. */
  attemptState?: string | null;
};

type TranscriptFetchState = {
  loading: boolean;
  error: string | null;
  events: AttemptTraceEvent[];
  hasEarlier: boolean;
  nextBefore?: number;
  cursor: number;
  loadingEarlier: boolean;
  /** True once at least one successful fetch completed for the current attempt. */
  ready: boolean;
};

const EMPTY_FETCH: TranscriptFetchState = {
  loading: false,
  error: null,
  events: [],
  hasEarlier: false,
  cursor: 0,
  loadingEarlier: false,
  ready: false,
};

function mergeTraceEvents(
  previous: readonly AttemptTraceEvent[],
  incoming: readonly AttemptTraceEvent[],
): AttemptTraceEvent[] {
  const byOrdinal = new Map(previous.map((event) => [event.ordinal, event]));
  for (const event of incoming) byOrdinal.set(event.ordinal, event);
  return [...byOrdinal.values()].toSorted((a, b) => a.ordinal - b.ordinal);
}

function AttemptTraceScroller({
  messages,
  streaming,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  jumpToLatestLabel,
  loadEarlierLabel,
}: {
  messages: ReturnType<typeof projectAttemptTranscriptMessages>;
  streaming: boolean;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  jumpToLatestLabel: string;
  loadEarlierLabel: string;
}) {
  return (
    <MessageScrollerProvider autoScroll={streaming}>
      <MessageScroller data-testid="attempt-trace-scroller" className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-3 px-1 py-1">
            {hasEarlier ? (
              <div className="flex justify-center py-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingEarlier}
                  onClick={onLoadEarlier}
                  data-testid="attempt-trace-load-earlier"
                >
                  <ChevronUpIcon data-icon="inline-start" />
                  {loadEarlierLabel}
                </Button>
              </div>
            ) : null}
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === "user"}
              >
                <TranscriptMessage message={message} />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          aria-label={jumpToLatestLabel}
          data-testid="attempt-trace-jump-latest"
        />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

export function NodeAttemptDialog({
  open,
  onOpenChange,
  nodeLabel,
  nodeKey,
  attempt,
  relatedAttempts = [],
  onSelectAttempt,
  footer,
  workspaceId,
  runId,
  attemptId,
  attemptState,
}: NodeAttemptDialogProps) {
  const { t } = useI18n();
  const rounds = relatedAttempts.length > 0 ? relatedAttempts : attempt ? [attempt] : [];

  const effectiveAttemptId = attemptId ?? attempt?.attemptId ?? null;
  // Prefer durable WikiRunAttempt.state; fall back to projected NodeAttempt.status.
  const effectiveState =
    attemptState ??
    (attempt?.status === "running"
      ? "running"
      : attempt?.status === "awaiting"
        ? "suspended"
        : (attempt?.status ?? null));

  const canFetch = open && Boolean(workspaceId && runId && effectiveAttemptId);

  const [fetchState, setFetchState] = useState<TranscriptFetchState>(EMPTY_FETCH);
  /** True while Attempt transcript SSE is open (running/suspended). */
  const [streamingLive, setStreamingLive] = useState(false);

  useEffect(() => {
    if (!canFetch || !workspaceId || !runId || !effectiveAttemptId) {
      setFetchState(EMPTY_FETCH);
      setStreamingLive(false);
      return;
    }

    let cancelled = false;
    setFetchState({ ...EMPTY_FETCH, loading: true });
    setStreamingLive(false);

    let source: EventSource | undefined;
    const closeSource = (): void => {
      try {
        source?.close();
      } catch {
        // Browser transport cleanup is best effort.
      }
    };

    void (async () => {
      try {
        // Load the newest page first. Earlier evidence is fetched only when the
        // operator asks, while new entries arrive through this dialog-scoped SSE.
        const data = await getWikiRunAttemptTranscript(workspaceId, runId, effectiveAttemptId);
        if (cancelled) return;
        setFetchState({
          loading: false,
          error: null,
          events: data.events,
          hasEarlier: data.hasEarlier,
          ...(data.nextBefore !== undefined ? { nextBefore: data.nextBefore } : {}),
          cursor: data.cursor,
          loadingEarlier: false,
          ready: true,
        });

        if (!isAttemptTranscriptLive(data.state) || typeof EventSource === "undefined") return;
        source = new EventSource(
          wikiRunAttemptTranscriptEventsUrl(workspaceId, runId, effectiveAttemptId, {
            after: data.cursor,
          }),
        );
        setStreamingLive(true);

        source.addEventListener("trace", ((ev: MessageEvent<string>) => {
          if (cancelled) return;
          try {
            const update = JSON.parse(ev.data) as {
              events?: AttemptTraceEvent[];
              cursor?: number;
              live?: boolean;
            };
            if (!Array.isArray(update.events)) return;
            setFetchState((prev) => ({
              ...prev,
              error: null,
              events: mergeTraceEvents(prev.events, update.events),
              cursor:
                typeof update.cursor === "number"
                  ? Math.max(prev.cursor, update.cursor)
                  : prev.cursor,
              ready: true,
            }));
            if (update.live === false) setStreamingLive(false);
          } catch {
            // Ignore malformed diagnostic frames; the next cursor page repairs it.
          }
        }) as EventListener);
        source.addEventListener("done", (() => {
          if (!cancelled) setStreamingLive(false);
          closeSource();
        }) as EventListener);
        source.addEventListener("transcript_error", ((ev: MessageEvent<string>) => {
          if (cancelled) return;
          let message = "trace stream error";
          try {
            const data = JSON.parse(ev.data) as { message?: string };
            message = data.message?.trim() || message;
          } catch {
            // use the safe fallback above
          }
          setFetchState((prev) => ({ ...prev, loading: false, error: message, ready: true }));
          setStreamingLive(false);
          closeSource();
        }) as EventListener);
        source.onerror = () => {
          if (cancelled || source?.readyState !== EventSource.CLOSED) return;
          setStreamingLive(false);
        };
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setFetchState({ ...EMPTY_FETCH, ready: true });
          return;
        }
        setFetchState({
          ...EMPTY_FETCH,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          ready: true,
        });
      }
    })();

    return () => {
      cancelled = true;
      setStreamingLive(false);
      closeSource();
    };
  }, [canFetch, workspaceId, runId, effectiveAttemptId, effectiveState]);

  const loadEarlier = useCallback(async () => {
    if (!workspaceId || !runId || !effectiveAttemptId || !fetchState.hasEarlier) return;
    setFetchState((prev) => ({ ...prev, loadingEarlier: true, error: null }));
    try {
      const data = await getWikiRunAttemptTranscript(workspaceId, runId, effectiveAttemptId, {
        before: fetchState.nextBefore ?? fetchState.events[0]?.ordinal,
      });
      setFetchState((prev) => ({
        ...prev,
        events: mergeTraceEvents(prev.events, data.events),
        hasEarlier: data.hasEarlier,
        ...(data.nextBefore !== undefined ? { nextBefore: data.nextBefore } : {}),
        loadingEarlier: false,
      }));
    } catch (error) {
      setFetchState((prev) => ({
        ...prev,
        loadingEarlier: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [workspaceId, runId, effectiveAttemptId, fetchState]);

  const projected = useMemo(
    () => projectAttemptTranscriptMessages(fetchState.events),
    [fetchState.events],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // Trace is a first-class inspector pane, not a short nested wall.
          "z-[60] flex h-[calc(100dvh-1rem)] w-full max-h-[60rem] flex-col gap-0 overflow-hidden p-0 sm:h-[min(92vh,60rem)] sm:max-w-5xl",
        )}
        overlayClassName="z-[60]"
        data-testid="run-graph-node-dialog"
        data-node-key={nodeKey}
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-4 py-3 pr-12 text-left">
          <DialogTitle className="truncate text-base">{nodeLabel}</DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            {nodeKey}
          </DialogDescription>
        </DialogHeader>

        {rounds.length > 1 ? (
          <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-4 py-2">
            {rounds.map((a) => {
              const active = attempt?.attemptId === a.attemptId;
              return (
                <button
                  key={a.attemptId}
                  type="button"
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-2xs",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    active
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/50",
                  )}
                  data-testid="run-graph-dialog-round"
                  data-attempt-id={a.attemptId}
                  onClick={() => onSelectAttempt?.(a.attemptId)}
                >
                  r{a.runIndex + 1} · {a.status}
                </button>
              );
            })}
          </div>
        ) : null}

        <div
          className="flex min-h-0 flex-1 flex-col px-4 py-3"
          data-testid="run-graph-dialog-scroll"
        >
          <div
            className="flex min-h-0 flex-1 flex-col gap-3"
            data-testid="run-graph-attempt-inspector"
          >
            {!attempt ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="run-graph-attempt-inspector-empty"
              >
                {t.agentWorkspace.runGraphAttemptEmpty}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{attempt.status}</Badge>
                  {attempt.role ? (
                    <span className="text-xs text-muted-foreground">{attempt.role}</span>
                  ) : null}
                  {attempt.runIndex > 0 ? (
                    <span className="font-mono text-2xs text-muted-foreground">
                      r{attempt.runIndex + 1}
                    </span>
                  ) : null}
                </div>

                {attempt.summary ? (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <p className="okf-section-label">{t.agentWorkspace.runGraphAttempt}</p>
                    <div className="min-w-0 rounded-md border border-border/60 bg-muted/20 p-2.5">
                      <AgentMarkdown content={attempt.summary} />
                    </div>
                  </div>
                ) : null}

                {(attempt.errorClass || attempt.receiptPath || attempt.usage) && (
                  <>
                    <Separator />
                    <dl className="grid gap-1.5 text-xs">
                      {attempt.errorClass ? (
                        <div className="flex gap-2">
                          <dt className="shrink-0 text-muted-foreground">
                            {t.agentWorkspace.attemptErrorLabel}
                          </dt>
                          <dd className="min-w-0 break-all font-mono text-destructive">
                            {attempt.errorClass}
                          </dd>
                        </div>
                      ) : null}
                      {attempt.receiptPath ? (
                        <div className="flex gap-2">
                          <dt className="shrink-0 text-muted-foreground">
                            {t.agentWorkspace.attemptReceiptLabel}
                          </dt>
                          <dd className="min-w-0 break-all font-mono text-muted-foreground">
                            {attempt.receiptPath}
                          </dd>
                        </div>
                      ) : null}
                      {attempt.usage?.contextTokens != null ? (
                        <div className="flex gap-2">
                          <dt className="shrink-0 text-muted-foreground">
                            {t.agentWorkspace.attemptCtxLabel}
                          </dt>
                          <dd className="font-mono">{attempt.usage.contextTokens}</dd>
                        </div>
                      ) : null}
                      {attempt.usage?.turns != null ? (
                        <div className="flex gap-2">
                          <dt className="shrink-0 text-muted-foreground">
                            {t.agentWorkspace.attemptTurnsLabel}
                          </dt>
                          <dd className="font-mono">{attempt.usage.turns}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </>
                )}

                {canFetch ? (
                  <>
                    <Separator />
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5">
                      <p className="okf-section-label">
                        {t.agentWorkspace.attemptTranscript}
                        {streamingLive || isAttemptTranscriptLive(effectiveState) ? (
                          <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground">
                            · {t.agentWorkspace.attemptTranscriptLive}
                          </span>
                        ) : null}
                      </p>
                      <div
                        className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-md border border-border/60 bg-muted/10 px-2.5 py-2"
                        data-testid="attempt-transcript"
                        data-attempt-id={effectiveAttemptId ?? undefined}
                        data-attempt-state={effectiveState ?? undefined}
                      >
                        {fetchState.loading && !fetchState.ready ? (
                          <div
                            className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
                            data-testid="attempt-transcript-loading"
                          >
                            <Spinner className="size-3.5" />
                            {t.common.loading}
                          </div>
                        ) : null}
                        {fetchState.error ? (
                          <p
                            className="text-xs text-destructive"
                            data-testid="attempt-transcript-error"
                          >
                            {fetchState.error}
                          </p>
                        ) : null}
                        {fetchState.ready && projected.length === 0 ? (
                          <p
                            className="text-xs text-muted-foreground"
                            data-testid="attempt-transcript-empty"
                          >
                            {t.agentWorkspace.attemptTranscriptEmpty}
                          </p>
                        ) : null}
                        {projected.length > 0 ? (
                          <AttemptTraceScroller
                            messages={projected}
                            streaming={streamingLive}
                            hasEarlier={fetchState.hasEarlier}
                            loadingEarlier={fetchState.loadingEarlier}
                            onLoadEarlier={() => void loadEarlier()}
                            jumpToLatestLabel={t.agentWorkspace.jumpToLatest}
                            loadEarlierLabel={t.agentWorkspace.attemptTranscriptLoadEarlier}
                          />
                        ) : null}
                      </div>
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>

        {footer ? <div className="shrink-0 border-t border-border px-4 py-3">{footer}</div> : null}
      </DialogContent>
    </Dialog>
  );
}
