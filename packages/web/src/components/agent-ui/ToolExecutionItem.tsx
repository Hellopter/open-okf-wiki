import { WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolItemVM } from "./adapters/types";
import { ActivityCollapsible } from "./ActivityCollapsible";
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

function headerTrigger(item: ToolItemVM, descriptor: ReturnType<typeof describeToolStatus>) {
  return (
    <>
      <StatusGlyph descriptor={descriptor} className="size-4" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {item.title}
      </span>
      <StatusBadge descriptor={descriptor}>{item.statusLabel ?? item.status}</StatusBadge>
    </>
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
    item.summary !== item.outputText;
  // When errored, outputText is usually the same payload as errorText — don't double-count.
  const showOutput = Boolean(item.outputText) && !item.errorText;
  const hasBody =
    showSummary || Boolean(item.inputText) || showOutput || Boolean(item.errorText);

  const openRunButton =
    item.openRunId && onOpenRun ? (
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="mt-1 shrink-0"
        onClick={() => onOpenRun(item.openRunId!)}
      >
        <WorkflowIcon data-icon="inline-start" />
        {openRunLabel}
      </Button>
    ) : null;

  if (!hasBody) {
    return (
      <div
        className={cn("flex w-full min-w-0 items-start gap-2", className)}
        data-testid={item.testId}
        data-slot="tool-execution-item"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 border-y border-border py-2">
          {headerTrigger(item, descriptor)}
        </div>
        {openRunButton}
      </div>
    );
  }

  return (
    <div
      className={cn("flex w-full min-w-0 items-start gap-2", className)}
      data-testid={item.testId}
      data-slot="tool-execution-item"
    >
      <ActivityCollapsible
        defaultOpen={item.defaultOpen}
        className="min-w-0 flex-1 border-y border-border py-2"
        trigger={headerTrigger(item, descriptor)}
        contentClassName="mt-2 space-y-2"
      >
        {showSummary ? (
          <p className="text-sm text-muted-foreground">{item.summary}</p>
        ) : null}
        {item.inputText ? (
          <DiffSurface
            value={item.inputText}
            label={inputLabel}
            copyable
            copyLabel={copyLabel}
            copiedLabel={copiedLabel}
          />
        ) : null}
        {item.errorText ? (
          <CodeSurface
            value={item.errorText}
            label={errorLabel ?? outputLabel}
            className="[&_pre]:border-destructive/40"
            copyable
            copyLabel={copyLabel}
            copiedLabel={copiedLabel}
          />
        ) : item.outputText ? (
          <DiffSurface
            value={item.outputText}
            label={outputLabel}
            copyable
            copyLabel={copyLabel}
            copiedLabel={copiedLabel}
          />
        ) : null}
      </ActivityCollapsible>
      {openRunButton}
    </div>
  );
}
