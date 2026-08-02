import { ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { aggregateFileChanges } from "./adapters/tool-fields";
import type { ToolFileChange, ToolItemVM } from "./adapters/types";
import { ToolChipRow } from "./ToolChipRow";

const FILE_FOOTER_VISIBLE = 3;

export type ToolChipGroupProps = {
  items: ToolItemVM[];
  openRunLabel: string;
  inputLabel?: string;
  outputLabel?: string;
  errorLabel?: string;
  /** Template with `{count}` placeholder, e.g. "{count} tool calls". */
  toolCallsSummaryLabel: string;
  /**
   * Optional template with `{count}` and `{messages}`, e.g.
   * "{count} tool calls, {messages} messages". Used when messageCount > 0.
   */
  toolCallsWithMessagesLabel?: string;
  /** Interleaved assistant text segments associated with this tool group / turn. */
  messageCount?: number;
  /** Template for overflow file chips, e.g. "+{count} more". */
  moreFilesLabel?: string;
  onOpenRun?: (runId: string) => void;
  className?: string;
};

function isSettled(status: ToolItemVM["status"]): boolean {
  return status === "done" || status === "error";
}

function formatToolSummary(
  toolCount: number,
  messageCount: number | undefined,
  toolOnly: string,
  withMessages: string | undefined,
): string {
  if (messageCount && messageCount > 0 && withMessages) {
    return withMessages
      .replace(/\{count\}/g, String(toolCount))
      .replace(/\{messages\}/g, String(messageCount));
  }
  return toolOnly.replace(/\{count\}/g, String(toolCount));
}

function FileChangeFooter({
  changes,
  moreFilesLabel,
}: {
  changes: ToolFileChange[];
  moreFilesLabel?: string;
}) {
  if (changes.length === 0) return null;
  const visible = changes.slice(0, FILE_FOOTER_VISIBLE);
  const overflow = changes.length - visible.length;
  const moreTemplate = moreFilesLabel ?? "+{count} more";

  return (
    <div
      className="mt-2 flex max-w-full flex-wrap gap-1.5 border-t border-border/60 pt-2.5"
      data-slot="tool-file-footer"
    >
      {visible.map((change) => (
        <span
          key={change.file}
          className="inline-flex h-7 max-w-full cursor-default items-center gap-1.5 rounded-md bg-muted/60 px-2 font-mono text-[11.5px] text-foreground"
          title={change.file}
        >
          <span className="min-w-0 truncate">{change.file}</span>
          {change.add > 0 ? (
            <span className="shrink-0 tabular-nums text-success">+{change.add}</span>
          ) : null}
          {change.del > 0 ? (
            <span className="shrink-0 tabular-nums text-destructive">−{change.del}</span>
          ) : null}
          {change.add === 0 && change.del === 0 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">0</span>
          ) : null}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="inline-flex h-7 items-center px-1.5 font-mono text-[11.5px] text-muted-foreground">
          {moreTemplate.replace(/\{count\}/g, String(overflow))}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Renders one or many tool chip rows.
 * Single item: bare row (+ optional file footer).
 * Multiple settled: text-only summary trigger → list of rows + file footer.
 * Multiple with live work: expand each row individually (no summary panel).
 */
export function ToolChipGroup({
  items,
  openRunLabel,
  inputLabel,
  outputLabel,
  errorLabel,
  toolCallsSummaryLabel,
  toolCallsWithMessagesLabel,
  messageCount,
  moreFilesLabel,
  onOpenRun,
  className,
}: ToolChipGroupProps) {
  const fileChanges = useMemo(() => aggregateFileChanges(items), [items]);

  if (items.length === 0) return null;

  const shared = {
    openRunLabel,
    inputLabel,
    outputLabel,
    errorLabel,
    onOpenRun,
  };

  if (items.length === 1) {
    return (
      <div className={className} data-slot="tool-chip-group">
        <ToolChipRow item={items[0]!} {...shared} />
        {isSettled(items[0]!.status) ? (
          <FileChangeFooter changes={fileChanges} moreFilesLabel={moreFilesLabel} />
        ) : null}
      </div>
    );
  }

  const allSettled = items.every((item) => isSettled(item.status));

  if (allSettled) {
    return (
      <SettledToolChipGroup
        items={items}
        fileChanges={fileChanges}
        toolCallsSummaryLabel={toolCallsSummaryLabel}
        toolCallsWithMessagesLabel={toolCallsWithMessagesLabel}
        messageCount={messageCount}
        moreFilesLabel={moreFilesLabel}
        className={className}
        shared={shared}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-0.5", className)} data-slot="tool-chip-group">
      {items.map((item) => (
        <ToolChipRow
          key={item.id}
          item={{
            ...item,
            defaultOpen: item.defaultOpen || item.status === "pending" || item.status === "running",
          }}
          {...shared}
        />
      ))}
    </div>
  );
}

function SettledToolChipGroup({
  items,
  fileChanges,
  toolCallsSummaryLabel,
  toolCallsWithMessagesLabel,
  messageCount,
  moreFilesLabel,
  className,
  shared,
}: {
  items: ToolItemVM[];
  fileChanges: ToolFileChange[];
  toolCallsSummaryLabel: string;
  toolCallsWithMessagesLabel?: string;
  messageCount?: number;
  moreFilesLabel?: string;
  className?: string;
  shared: {
    openRunLabel: string;
    inputLabel?: string;
    outputLabel?: string;
    errorLabel?: string;
    onOpenRun?: (runId: string) => void;
  };
}) {
  const hasError = items.some((item) => item.status === "error");
  // Auto-open when any tool failed so errors are not buried under the count.
  const [open, setOpen] = useState(hasError);
  const summary = formatToolSummary(
    items.length,
    messageCount,
    toolCallsSummaryLabel,
    toolCallsWithMessagesLabel,
  );

  return (
    <div className={className} data-slot="tool-chip-group">
      <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
        <CollapsibleTrigger
          className={cn(
            "-mx-1.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px]",
            "text-muted-foreground outline-none transition-colors duration-100",
            "hover:bg-muted/50 hover:text-foreground",
            "focus-visible:ring-3 focus-visible:ring-ring/50",
            hasError && "text-destructive hover:text-destructive",
          )}
        >
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 transition-transform duration-200",
              open ? "rotate-0" : "-rotate-90",
            )}
            aria-hidden
          />
          <span className="tabular-nums">{summary}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="min-w-0 overflow-hidden">
          <div className="mt-1 flex flex-col gap-0.5 pb-0.5">
            {items.map((item) => (
              <ToolChipRow key={item.id} item={item} {...shared} />
            ))}
            <FileChangeFooter changes={fileChanges} moreFilesLabel={moreFilesLabel} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
