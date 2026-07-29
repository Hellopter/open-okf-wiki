/**
 * Popup for a single run-graph node's attempt(s).
 *
 * Tool trail (OpenCode / Claude / Codex style): one dense line per tool —
 *   [✓] read  settings.ts  offset=… limit=…
 * not bordered cards dumping raw JSON args.
 *
 * Scroll: flex column shell + native overflow-y body.
 * Summary text: MarkdownDocument.
 */

import type { AttemptItem, NodeAttempt } from "@okf-wiki/contract";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { MarkdownDocument } from "../../shared/MarkdownDocument";
import { ToolStatusGlyph } from "../components/tool-display/glyphs";
import { toolIcon } from "../components/tool-display/icons";
import {
  formatToolDisplay,
  parseToolInput,
  toolPathLabel,
} from "../components/tool-display/summary";

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

export function NodeAttemptDialog({
  open,
  onOpenChange,
  nodeLabel,
  nodeKey,
  attempt,
  relatedAttempts = [],
  onSelectAttempt,
  footer,
}: NodeAttemptDialogProps) {
  const { t } = useI18n();
  const rounds = relatedAttempts.length > 0 ? relatedAttempts : attempt ? [attempt] : [];

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
              </>
            )}
          </div>
        </div>

        {footer ?? null}
      </DialogContent>
    </Dialog>
  );
}
