/**
 * Popup for a single run-graph node's attempt(s).
 *
 * Tool trail (OpenCode / Claude / Codex style): one dense line per tool —
 *   [✓] read  settings.ts  offset=… limit=…
 * not bordered cards dumping raw JSON args.
 *
 * Attempt transcript:
 * - completed → GET …/transcript (one-shot render)
 * - running/suspended → EventSource …/transcript/events (live snapshots)
 * Not Session SSE; not Run control SSE.
 *
 * Scroll: flex column shell + native overflow-y body.
 * Summary text: MarkdownDocument.
 */

import type { AttemptItem, NodeAttempt } from "@okf-wiki/contract";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ApiError,
  getWikiRunAttemptTranscript,
  wikiRunAttemptTranscriptEventsUrl,
} from "../../api";
import { useI18n } from "../../i18n";
import { MarkdownDocument } from "../../shared/MarkdownDocument";
import { ToolStatusGlyph } from "../components/tool-display/glyphs";
import { toolIcon } from "../components/tool-display/icons";
import {
  formatToolDisplay,
  parseToolInput,
  toolPathLabel,
} from "../components/tool-display/summary";
import {
  isAttemptTranscriptLive,
  projectAttemptTranscriptMessages,
  type ProjectedAttemptTranscriptEntry,
} from "./attempt-transcript";

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
  rootPath?: string;
  /** Explicit attempt id (preferred over attempt.attemptId when set). */
  attemptId?: string | null;
  /** WikiRunAttempt.state (or equivalent); drives live polling while `running`. */
  attemptState?: string | null;
};

/**
 * Parse attempt item argsSummary (often a JSON string) into OpenCode-style one-liner.
 */
function AttemptToolLine({ item }: { item: Extract<AttemptItem, { type: "toolCall" }> }) {
  const display = formatToolDisplay(
    item.name,
    parseToolInput(item.argsSummary) ?? item.argsSummary,
  );
  const Icon = toolIcon(item.name);
  const isError = item.status === "error";
  const isRunning = item.status === "running";

  // Prefer path-ish subtitle; fall back to truncated raw args without full JSON walls.
  let subtitle = display.subtitle;
  if (!subtitle && item.argsSummary) {
    const params = parseToolInput(item.argsSummary);
    const path =
      params &&
      (typeof params.path === "string"
        ? params.path
        : typeof params.file_path === "string"
          ? params.file_path
          : undefined);
    if (path) {
      subtitle = toolPathLabel(path);
    } else if (!item.argsSummary.trim().startsWith("{")) {
      subtitle =
        item.argsSummary.length > 64 ? `${item.argsSummary.slice(0, 63)}…` : item.argsSummary;
    }
  }

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 py-0.5 text-xs leading-5"
      data-testid="attempt-tool-line"
      data-tool-name={item.name}
      data-tool-status={item.status}
    >
      <ToolStatusGlyph status={item.status} />
      <Icon
        className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")}
      />
      <span className="min-w-0 flex-1 truncate">
        <span
          className={cn(
            "font-medium",
            isRunning && "text-muted-foreground",
            isError && "text-destructive",
          )}
        >
          {display.title}
        </span>
        {subtitle ? (
          <span
            className={cn(
              "ml-1.5 text-muted-foreground",
              display.subtitleMono && "font-mono text-2xs",
            )}
            title={item.argsSummary}
          >
            {subtitle}
          </span>
        ) : null}
        {display.args?.map((arg) => (
          <span key={arg} className="ml-1.5 font-mono text-2xs text-muted-foreground/80">
            {arg}
          </span>
        ))}
      </span>
    </div>
  );
}

function AttemptTranscriptRow({
  entry,
  streaming = false,
}: {
  entry: ProjectedAttemptTranscriptEntry;
  streaming?: boolean;
}) {
  if (entry.kind === "role") {
    return (
      <div
        className="flex min-w-0 flex-col gap-0.5 py-1"
        data-testid="attempt-transcript-role"
        data-role={entry.role}
      >
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {entry.role}
        </span>
        <div className="max-h-48 min-w-0 overflow-auto text-xs leading-5">
          <MarkdownDocument
            content={entry.text}
            mode={streaming ? "streaming" : "static"}
            surface="agent"
            className="text-xs"
          />
        </div>
      </div>
    );
  }
  if (entry.kind === "tool") {
    return (
      <div
        className="truncate py-0.5 font-mono text-2xs text-muted-foreground"
        data-testid="attempt-transcript-tool"
        title={entry.text}
      >
        ▸ {entry.text}
      </div>
    );
  }
  return (
    <div
      className="truncate py-0.5 font-mono text-2xs text-muted-foreground/80"
      data-testid="attempt-transcript-raw"
      title={entry.text}
    >
      {entry.text}
    </div>
  );
}

type TranscriptFetchState = {
  loading: boolean;
  error: string | null;
  messages: unknown[];
  /** True once at least one successful fetch completed for the current attempt. */
  ready: boolean;
};

const EMPTY_FETCH: TranscriptFetchState = {
  loading: false,
  error: null,
  messages: [],
  ready: false,
};

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
  rootPath,
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
        : attempt?.status ?? null);

  const canFetch =
    open && Boolean(workspaceId && runId && effectiveAttemptId);

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
    setFetchState({ loading: true, error: null, messages: [], ready: false });
    setStreamingLive(false);

    // Completed (or unknown idle): one-shot GET, normal render — no SSE.
    if (!isAttemptTranscriptLive(effectiveState)) {
      void (async () => {
        try {
          const data = await getWikiRunAttemptTranscript(
            workspaceId,
            runId,
            effectiveAttemptId,
            rootPath,
          );
          if (cancelled) return;
          setFetchState({
            loading: false,
            error: null,
            messages: Array.isArray(data.messages) ? data.messages : [],
            ready: true,
          });
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 404) {
            setFetchState({ loading: false, error: null, messages: [], ready: true });
            return;
          }
          setFetchState({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
            messages: [],
            ready: true,
          });
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // Live attempt: open dialog → Attempt transcript SSE (not Run control SSE).
    if (typeof EventSource === "undefined") {
      setFetchState({
        loading: false,
        error: "EventSource is not available",
        messages: [],
        ready: true,
      });
      return;
    }

    const url = wikiRunAttemptTranscriptEventsUrl(
      workspaceId,
      runId,
      effectiveAttemptId,
      rootPath,
    );
    const source = new EventSource(url);
    setStreamingLive(true);

    const onTranscript = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(ev.data) as {
          messages?: unknown[];
          live?: boolean;
          state?: string;
        };
        setFetchState({
          loading: false,
          error: null,
          messages: Array.isArray(data.messages) ? data.messages : [],
          ready: true,
        });
        if (data.live === false) setStreamingLive(false);
      } catch {
        // ignore malformed frame
      }
    };

    const onDone = () => {
      if (cancelled) return;
      setStreamingLive(false);
      // Server closes after `done`; EventSource may error — treat as clean end.
      try {
        source.close();
      } catch {
        // ignore
      }
    };

    const onTranscriptError = (ev: MessageEvent<string>) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(ev.data) as { message?: string };
        setFetchState((prev) => ({
          loading: false,
          error: data.message?.trim() || "transcript stream error",
          messages: prev.messages,
          ready: true,
        }));
      } catch {
        setFetchState((prev) => ({
          loading: false,
          error: "transcript stream error",
          messages: prev.messages,
          ready: true,
        }));
      }
      setStreamingLive(false);
      try {
        source.close();
      } catch {
        // ignore
      }
    };

    source.addEventListener("transcript", onTranscript as EventListener);
    source.addEventListener("done", onDone as EventListener);
    source.addEventListener("transcript_error", onTranscriptError as EventListener);
    // Native connection errors — keep last good frame; do not clear messages.
    source.onerror = () => {
      if (cancelled) return;
      if (source.readyState === EventSource.CLOSED) {
        setStreamingLive(false);
        setFetchState((prev) =>
          prev.ready
            ? { ...prev, loading: false }
            : { loading: false, error: null, messages: prev.messages, ready: true },
        );
      }
    };

    return () => {
      cancelled = true;
      setStreamingLive(false);
      source.removeEventListener("transcript", onTranscript as EventListener);
      source.removeEventListener("done", onDone as EventListener);
      source.removeEventListener("transcript_error", onTranscriptError as EventListener);
      source.close();
    };
  }, [canFetch, workspaceId, runId, effectiveAttemptId, rootPath, effectiveState]);

  const projected = useMemo(
    () => projectAttemptTranscriptMessages(fetchState.messages),
    [fetchState.messages],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // Wider than default sm:max-w-sm / max-w-lg — room for path trails + MD.
          "flex max-h-[min(85vh,44rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl",
        )}
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
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
          data-testid="run-graph-dialog-scroll"
        >
          <div className="flex flex-col gap-3" data-testid="run-graph-attempt-inspector">
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
                      <MarkdownDocument
                        content={attempt.summary}
                        mode="static"
                        surface="agent"
                        className="text-xs"
                      />
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

                {(attempt.items?.length ?? 0) > 0 ? (
                  <>
                    <Separator />
                    <div className="flex flex-col gap-0.5" data-testid="attempt-tool-trail">
                      {attempt.items!.map((item, index) =>
                        item.type === "toolCall" ? (
                          <AttemptToolLine key={`${attempt.attemptId}-tool-${index}`} item={item} />
                        ) : (
                          <div key={`${attempt.attemptId}-text-${index}`} className="min-w-0 py-1">
                            <MarkdownDocument
                              content={item.text}
                              mode="static"
                              surface="agent"
                              className="text-xs"
                            />
                          </div>
                        ),
                      )}
                    </div>
                  </>
                ) : null}

                {canFetch ? (
                  <>
                    <Separator />
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="okf-section-label">
                        {t.agentWorkspace.attemptTranscript}
                        {streamingLive || isAttemptTranscriptLive(effectiveState) ? (
                          <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground">
                            · {t.agentWorkspace.attemptTranscriptLive}
                          </span>
                        ) : null}
                      </p>
                      <div
                        className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 bg-muted/10 px-2.5 py-2"
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
                        ) : fetchState.error ? (
                          <p
                            className="text-xs text-destructive"
                            data-testid="attempt-transcript-error"
                          >
                            {fetchState.error}
                          </p>
                        ) : projected.length === 0 ? (
                          <p
                            className="text-xs text-muted-foreground"
                            data-testid="attempt-transcript-empty"
                          >
                            {t.agentWorkspace.attemptTranscriptEmpty}
                          </p>
                        ) : (
                          projected.map((entry, index) => (
                            <AttemptTranscriptRow
                              key={`${effectiveAttemptId}-tx-${index}`}
                              entry={entry}
                              streaming={streamingLive}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>

        {footer ?? null}
      </DialogContent>
    </Dialog>
  );
}
