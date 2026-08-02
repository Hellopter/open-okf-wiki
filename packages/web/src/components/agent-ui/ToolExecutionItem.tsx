import { WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActivityCollapsible } from "./ActivityCollapsible";
import type { ToolItemVM } from "./adapters/types";
import { CodeSurface } from "./CodeSurface";
import { DiffSurface } from "./DiffSurface";
import { StatusBadge } from "./StatusBadge";
import { StatusGlyph } from "./StatusGlyph";
import { describeToolStatus } from "./status";

export type ToolExecutionItemProps = {
  item: ToolItemVM;
  openRunLabel: string;
  inputLabel: string;
  outputLabel: string;
  /** Label for error payload surface; falls back to outputLabel. */
  errorLabel?: string;
  onOpenRun?: (runId: string) => void;
  copyLabel?: string;
  copiedLabel?: string;
  className?: string;
};

function HeaderRow({
  item,
  descriptor,
  showChevronSpacer,
}: {
  item: ToolItemVM;
  descriptor: ReturnType<typeof describeToolStatus>;
  /** Reserve space so static rows align with collapsible rows that show a chevron. */
  showChevronSpacer?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <StatusGlyph descriptor={descriptor} className="mt-0.5 size-3.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {item.title}
          </span>
          <StatusBadge descriptor={descriptor} className="text-[10px]">
            {item.statusLabel ?? item.status}
          </StatusBadge>
          {showChevronSpacer ? <span className="size-4 shrink-0" aria-hidden /> : null}
        </div>
        {item.headline ? (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {item.headline}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OpenRunButton({
  openRunId,
  openRunLabel,
  onOpenRun,
}: {
  openRunId: string;
  openRunLabel: string;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="h-6 shrink-0 px-1.5 text-[11px]"
      onClick={() => onOpenRun(openRunId)}
    >
      <WorkflowIcon data-icon="inline-start" className="size-3" />
      {openRunLabel}
    </Button>
  );
}

export function ToolExecutionItem({
  item,
  openRunLabel,
  inputLabel,
  outputLabel,
  errorLabel,
  onOpenRun,
  copyLabel,
  copiedLabel,
  className,
}: ToolExecutionItemProps) {
  const descriptor = describeToolStatus(item.status);
  const showSummary =
    Boolean(item.summary) &&
    item.summary !== item.errorText &&
    item.summary !== item.outputText &&
    item.summary !== item.headline;
  // When errored, outputText is usually the same payload as errorText — don't double-count.
  const showOutput = Boolean(item.outputText) && !item.errorText;
  const showPrimaryFields = Boolean(item.primaryFields && item.primaryFields.length > 0);
  // Raw I/O is secondary; only count as expandable body content.
  const hasRawInput = Boolean(item.inputText);
  const hasRawOutput = showOutput;
  const hasError = Boolean(item.errorText);
  const hasBody = showSummary || showPrimaryFields || hasRawInput || hasRawOutput || hasError;

  const shellClass = cn(
    "w-full min-w-0 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2",
    className,
  );

  const openRun =
    item.openRunId && onOpenRun ? (
      <OpenRunButton openRunId={item.openRunId} openRunLabel={openRunLabel} onOpenRun={onOpenRun} />
    ) : null;

  // Controlled open: expand while running/pending/error; collapse when done.
  const [open, setOpen] = useState(
    item.defaultOpen ||
      item.status === "running" ||
      item.status === "pending" ||
      item.status === "error",
  );

  useEffect(() => {
    if (item.status === "running" || item.status === "pending") setOpen(true);
    else if (item.status === "error") setOpen(true);
    else setOpen(false); // done
  }, [item.status]);

  if (!hasBody) {
    return (
      <div className={shellClass} data-testid={item.testId} data-slot="tool-execution-item">
        <div className="flex items-start gap-1">
          <HeaderRow item={item} descriptor={descriptor} showChevronSpacer />
          {openRun}
        </div>
      </div>
    );
  }

  // For done tools, keep raw I/O nested and collapsed; for error/running, surface error
  // (and optional streaming output) more prominently when the row is open.
  const rawDefaultOpen = item.status === "error" || item.status === "running";

  return (
    <div className={shellClass} data-testid={item.testId} data-slot="tool-execution-item">
      <div className="flex items-start gap-1">
        <ActivityCollapsible
          open={open}
          onOpenChange={setOpen}
          className="min-w-0 flex-1"
          triggerClassName="w-full"
          trigger={<HeaderRow item={item} descriptor={descriptor} />}
          contentClassName="mt-2 space-y-2 border-t border-border/50 pt-2"
        >
          {showSummary ? <p className="text-sm text-muted-foreground">{item.summary}</p> : null}

          {showPrimaryFields ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {item.primaryFields!.map((field) => (
                <div key={field.label} className="contents">
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="min-w-0 truncate font-mono text-foreground">{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {hasError ? (
            <CodeSurface
              value={item.errorText!}
              label={errorLabel ?? outputLabel}
              className="[&_pre]:border-destructive/40"
              copyable
              copyLabel={copyLabel}
              copiedLabel={copiedLabel}
            />
          ) : null}

          {hasRawInput || hasRawOutput ? (
            <div className="space-y-1.5">
              {hasRawInput ? (
                <ActivityCollapsible
                  key={`raw-input-${item.status}`}
                  defaultOpen={rawDefaultOpen && item.status === "running" && !hasRawOutput}
                  className="w-full min-w-0"
                  trigger={
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
                      {inputLabel}
                    </span>
                  }
                  contentClassName="mt-1.5"
                >
                  <DiffSurface
                    value={item.inputText!}
                    copyable
                    copyLabel={copyLabel}
                    copiedLabel={copiedLabel}
                    maxHeightClass="max-h-40"
                  />
                </ActivityCollapsible>
              ) : null}
              {hasRawOutput ? (
                <ActivityCollapsible
                  key={`raw-output-${item.status}`}
                  defaultOpen={rawDefaultOpen}
                  className="w-full min-w-0"
                  trigger={
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
                      {outputLabel}
                    </span>
                  }
                  contentClassName="mt-1.5"
                >
                  <DiffSurface
                    value={item.outputText!}
                    copyable
                    copyLabel={copyLabel}
                    copiedLabel={copiedLabel}
                    maxHeightClass="max-h-40"
                  />
                </ActivityCollapsible>
              ) : null}
            </div>
          ) : null}
        </ActivityCollapsible>
        {openRun}
      </div>
    </div>
  );
}
