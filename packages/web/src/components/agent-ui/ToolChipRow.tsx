import { ChevronDownIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolDetailLine, ToolItemVM } from "./adapters/types";
import { ToolKindIcon } from "./tool-kind-icon";

export type ToolChipRowProps = {
  item: ToolItemVM;
  openRunLabel: string;
  inputLabel?: string;
  outputLabel?: string;
  errorLabel?: string;
  onOpenRun?: (runId: string) => void;
  className?: string;
};

function detailToneClass(tone: ToolDetailLine["tone"]): string {
  switch (tone) {
    case "add":
    case "ok":
      return "text-success";
    case "del":
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function OpenRunControl({
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
      className="h-5 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      onClick={() => onOpenRun(openRunId)}
    >
      <WorkflowIcon className="size-3" data-icon="inline-start" />
      {openRunLabel}
    </Button>
  );
}

/**
 * Beautiful-UI-style tool chip row: icon · title · chip pill.
 * No bordered card shell. Expand shows a left-rail detail list.
 */
export function ToolChipRow({
  item,
  openRunLabel,
  inputLabel = "Input",
  outputLabel = "Output",
  errorLabel = "Error",
  onOpenRun,
  className,
}: ToolChipRowProps) {
  const detailLines = item.detailLines ?? [];
  const summaryOnChip = Boolean(item.summary && item.chip && item.summary === item.chip);
  const showSummary =
    Boolean(item.summary?.trim()) &&
    !summaryOnChip &&
    !detailLines.some((line) => line.text === item.summary);
  const showErrorRaw =
    Boolean(item.errorText) && !detailLines.some((line) => line.text === item.errorText);
  // Prefer detail lines; still allow raw args when they carry more than the short rail.
  const showRawInput =
    Boolean(item.inputText) &&
    item.status !== "error" &&
    (detailLines.length === 0 || (item.inputText?.includes("\n") ?? false));
  const showRawOutput =
    Boolean(item.outputText) &&
    !item.errorText &&
    !detailLines.some((line) => item.outputText?.startsWith(line.text.slice(0, 40) ?? ""));

  const hasBody =
    detailLines.length > 0 || showSummary || showErrorRaw || showRawInput || showRawOutput;

  const [open, setOpen] = useState(
    item.defaultOpen ||
      item.status === "running" ||
      item.status === "pending" ||
      item.status === "error",
  );

  useEffect(() => {
    if (item.status === "running" || item.status === "pending" || item.status === "error") {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [item.status]);

  const openRun =
    item.openRunId && onOpenRun ? (
      <OpenRunControl
        openRunId={item.openRunId}
        openRunLabel={openRunLabel}
        onOpenRun={onOpenRun}
      />
    ) : null;

  const ariaLabel = [item.title, item.chip, item.statusLabel ?? item.status]
    .filter(Boolean)
    .join(" · ");

  const mainRow = (
    <>
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <ToolKindIcon
          kind={item.kind}
          status={item.status}
          className={cn(
            "transition-opacity duration-100",
            hasBody && "group-hover/tool-row:opacity-0",
            hasBody && open && "opacity-0",
          )}
        />
        {hasBody ? (
          <ChevronDownIcon
            className={cn(
              "absolute size-3 text-muted-foreground transition-[opacity,transform] duration-150",
              open ? "rotate-0 opacity-100" : "-rotate-90 opacity-0 group-hover/tool-row:opacity-100",
            )}
            aria-hidden
          />
        ) : null}
      </span>

      <span
        className={cn(
          "shrink-0 text-[12.5px] font-medium",
          item.status === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {item.title}
      </span>

      {item.chip ? (
        <span
          className={cn(
            "inline-flex h-5 min-w-0 flex-1 items-center truncate rounded-md bg-muted/70 px-1.5 text-[11.5px] text-muted-foreground",
            item.chipMono && "font-mono",
          )}
        >
          {item.chip}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
    </>
  );

  if (!hasBody) {
    return (
      <div
        className={cn(
          "group/tool-row -mx-1 flex h-7 min-w-0 items-center gap-1 rounded-md px-1",
          className,
        )}
        data-slot="tool-chip-row"
        data-testid={item.testId}
        aria-label={ariaLabel}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">{mainRow}</div>
        {openRun}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("group/tool-row min-w-0", className)}
      data-slot="tool-chip-row"
      data-testid={item.testId}
    >
      <div className="-mx-1 flex h-7 min-w-0 items-center gap-1 rounded-md hover:bg-muted/50">
        <CollapsibleTrigger
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left",
            "outline-none transition-colors duration-100",
            "focus-visible:ring-3 focus-visible:ring-ring/50",
          )}
          aria-label={ariaLabel}
        >
          {mainRow}
        </CollapsibleTrigger>
        {openRun}
      </div>

      <CollapsibleContent className="min-w-0 overflow-hidden">
        <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-border py-0.5 pl-3.5">
          {showSummary ? (
            <span className="text-[11.5px] leading-[1.6] text-muted-foreground">{item.summary}</span>
          ) : null}

          {detailLines.map((line, index) => (
            <span
              key={`${index}-${line.text.slice(0, 32)}`}
              className={cn(
                "truncate text-[11.5px] leading-[1.6]",
                line.mono && "font-mono",
                detailToneClass(line.tone),
              )}
            >
              {line.text}
            </span>
          ))}

          {showErrorRaw ? (
            <span className="whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6] text-destructive">
              <span className="text-muted-foreground">{errorLabel}: </span>
              {item.errorText}
            </span>
          ) : null}

          {showRawInput ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
              <span className="text-muted-foreground/80">{inputLabel}{"\n"}</span>
              {item.inputText}
            </pre>
          ) : null}

          {showRawOutput ? (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
              <span className="text-muted-foreground/80">{outputLabel}{"\n"}</span>
              {item.outputText}
            </pre>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
