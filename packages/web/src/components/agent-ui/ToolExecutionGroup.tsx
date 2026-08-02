import { WrenchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActivityCollapsible } from "./ActivityCollapsible";
import type { ToolItemVM } from "./adapters/types";
import { StatusBadge } from "./StatusBadge";
import { ToolExecutionItem } from "./ToolExecutionItem";

export type ToolExecutionGroupProps = {
  items: ToolItemVM[];
  openRunLabel: string;
  inputLabel: string;
  outputLabel: string;
  errorLabel?: string;
  /** Template with `{count}` placeholder, e.g. "{count} tool calls". */
  toolCallsSummaryLabel: string;
  onOpenRun?: (runId: string) => void;
  copyLabel?: string;
  copiedLabel?: string;
  className?: string;
};

function isSettled(status: ToolItemVM["status"]): boolean {
  return status === "done" || status === "error";
}

function formatCount(template: string, count: number): string {
  return template.replace(/\{count\}/g, String(count));
}

/**
 * Renders one or many tool rows.
 * Single item: bare ToolExecutionItem.
 * Multiple settled: aggregate chip-style collapsible → list of compact items.
 * Multiple with live work: expand each item individually.
 */
export function ToolExecutionGroup({
  items,
  openRunLabel,
  inputLabel,
  outputLabel,
  errorLabel,
  toolCallsSummaryLabel,
  onOpenRun,
  copyLabel,
  copiedLabel,
  className,
}: ToolExecutionGroupProps) {
  if (items.length === 0) return null;

  const shared = {
    openRunLabel,
    inputLabel,
    outputLabel,
    errorLabel,
    onOpenRun,
    copyLabel,
    copiedLabel,
  };

  if (items.length === 1) {
    return (
      <div className={className} data-slot="tool-execution-group">
        <ToolExecutionItem item={items[0]!} {...shared} />
      </div>
    );
  }

  const allSettled = items.every((item) => isSettled(item.status));
  const hasActive = items.some((item) => item.status === "pending" || item.status === "running");

  if (allSettled && !hasActive) {
    const hasError = items.some((item) => item.status === "error");

    return (
      <div className={className} data-slot="tool-execution-group">
        <ActivityCollapsible
          defaultOpen={false}
          className="w-full min-w-0 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2"
          trigger={
            <>
              <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {formatCount(toolCallsSummaryLabel, items.length)}
              </span>
              <StatusBadge kind="tool" status={hasError ? "error" : "done"} className="text-[10px]">
                {items.length}
              </StatusBadge>
            </>
          }
          contentClassName="mt-2 space-y-1.5 border-t border-border/50 pt-2"
        >
          {items.map((item) => (
            <ToolExecutionItem key={item.id} item={item} {...shared} />
          ))}
        </ActivityCollapsible>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)} data-slot="tool-execution-group">
      {items.map((item) => (
        <ToolExecutionItem
          key={item.id}
          item={{
            ...item,
            // Keep in-flight rows open so operators can watch live I/O.
            defaultOpen: item.defaultOpen || item.status === "pending" || item.status === "running",
          }}
          {...shared}
        />
      ))}
    </div>
  );
}
