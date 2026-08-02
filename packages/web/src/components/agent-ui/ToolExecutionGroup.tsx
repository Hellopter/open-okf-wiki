import { WrenchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolItemVM } from "./adapters/types";
import { ActivityCollapsible } from "./ActivityCollapsible";
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
 * Multiple settled: aggregate collapsible chrome.
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
    return (
      <div className={className} data-slot="tool-execution-group">
        <ActivityCollapsible
          defaultOpen={false}
          className="w-full min-w-0 border-y border-border py-2"
          trigger={
            <>
              <WrenchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                {formatCount(toolCallsSummaryLabel, items.length)}
              </span>
              <StatusBadge kind="tool" status="done">
                {items.length}
              </StatusBadge>
            </>
          }
          contentClassName="mt-1 space-y-0"
        >
          {items.map((item) => (
            <ToolExecutionItem key={item.id} item={item} {...shared} />
          ))}
        </ActivityCollapsible>
      </div>
    );
  }

  return (
    <div className={cn("space-y-0", className)} data-slot="tool-execution-group">
      {items.map((item) => (
        <ToolExecutionItem
          key={item.id}
          item={{
            ...item,
            // Keep in-flight rows open so operators can watch live I/O.
            defaultOpen:
              item.defaultOpen || item.status === "pending" || item.status === "running",
          }}
          {...shared}
        />
      ))}
    </div>
  );
}
