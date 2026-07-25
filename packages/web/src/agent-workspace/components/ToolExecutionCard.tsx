/**
 * Tool call row — OpenCode BasicTool / pi-web specialized renderer style.
 *
 * Trigger (always visible):
 *   [status] [icon] title  subtitle  arg arg
 *
 * Expand (only when there is a result or write body):
 *   plain result text — NO "Input" / "Output" section labels.
 *   structured details for the real wiki_produce tool (WikiProduceGatePanel).
 *
 * Known tools put args on the trigger line; they are never re-dumped as JSON.
 */

import type { AgentResumeGateCommand } from "@okf-wiki/contract";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileIcon,
  LayersIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatToolResultText } from "../hooks/project/format";
import type { AgentToolCall } from "../hooks/project/types";
import { formatToolDisplay } from "./tool-display/summary";
import { WikiProduceGatePanel } from "./WikiProduceGatePanel";

const WIKI_PRODUCE_TOOL_NAME = "wiki_produce";

export type ToolExecutionCardProps = {
  tool: AgentToolCall;
  onResumeGate: (command: AgentResumeGateCommand) => Promise<void>;
  /**
   * When the parent work unit is settled, keep completed tools collapsed.
   * Pass `false` while a unit is still active so non-done tools expand.
   */
  settled?: boolean;
};

function toolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower === WIKI_PRODUCE_TOOL_NAME) {
    return LayersIcon;
  }
  if (lower === "read" || lower === "write" || lower === "edit" || lower === "ls") {
    return FileIcon;
  }
  if (lower === "grep" || lower === "find") {
    return SearchIcon;
  }
  return WrenchIcon;
}

function StatusGlyph({ status }: { status: AgentToolCall["status"] }) {
  if (status === "running" || status === "pending") {
    return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
  }
  if (status === "error") {
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "done") {
    return <CheckIcon className="size-3.5 shrink-0 text-success" />;
  }
  return null;
}

/**
 * Build expand body text.
 * OpenCode: expand children are result only (markdown/pre), never labeled Input.
 */
function expandBody(
  kind: ReturnType<typeof formatToolDisplay>["kind"],
  opts: {
    writePreview?: string;
    output: string;
  },
): string {
  const { writePreview, output } = opts;

  if (kind === "write-body") {
    const parts: string[] = [];
    if (writePreview) parts.push(writePreview);
    if (output) parts.push(output);
    return parts.join("\n\n");
  }

  if (kind === "raw" && writePreview && !output) {
    return writePreview;
  }

  return output;
}

export function ToolExecutionCard({ tool, onResumeGate, settled }: ToolExecutionCardProps) {
  const display = formatToolDisplay(tool.name, tool.args);
  const output = formatToolResultText(tool.output) ?? "";
  const isError = tool.status === "error";
  const isRunning = tool.status === "running" || tool.status === "pending";
  const isWikiProduce = tool.name.toLowerCase() === WIKI_PRODUCE_TOOL_NAME;
  const wikiDetails = isWikiProduce ? tool.details : undefined;

  const body = expandBody(display.kind, {
    writePreview: display.writePreview,
    output,
  });

  const canExpand =
    Boolean(wikiDetails) ||
    (!display.headerOnly &&
      (Boolean(body.trim()) ||
        isError ||
        (display.kind === "write-body" && Boolean(display.writePreview))));

  const autoOpen =
    isRunning || isError || (settled === false && tool.status !== "done" && canExpand);

  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  const Icon = toolIcon(tool.name);

  const trigger = (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left text-xs",
        canExpand && "hover:bg-muted/50",
      )}
    >
      {canExpand ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
      <StatusGlyph status={tool.status} />
      <Icon
        className={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")}
      />
      <span className="min-w-0 flex-1 truncate leading-5">
        <span
          className={cn(
            "font-medium",
            isRunning && "text-muted-foreground",
            isError && "text-destructive",
          )}
        >
          {isWikiProduce ? "wiki_produce" : display.title}
        </span>
        {display.subtitle ? (
          <span className="ml-1.5 text-muted-foreground">{display.subtitle}</span>
        ) : null}
        {display.args?.map((arg) => (
          <span key={arg} className="ml-1.5 font-mono text-[10px] text-muted-foreground/80">
            {arg}
          </span>
        ))}
      </span>
    </div>
  );

  if (!canExpand) {
    return (
      <div
        className="w-full min-w-0 rounded-md"
        data-testid="tool-execution-card"
        data-tool-name={tool.name}
        data-tool-status={tool.status}
        data-header-only="true"
      >
        {trigger}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group w-full min-w-0 rounded-md"
      data-testid="tool-execution-card"
      data-tool-name={tool.name}
      data-tool-status={tool.status}
    >
      <CollapsibleTrigger className="w-full min-w-0 rounded-md text-left">
        {trigger}
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 overflow-hidden pl-4 pr-1 pb-1.5 sm:pl-6">
        {body.trim() && !isWikiProduce ? (
          <pre
            className={cn(
              "okf-code-snippet max-h-64 overflow-auto text-[11px] leading-relaxed",
              isError && "text-destructive",
            )}
          >
            {body}
          </pre>
        ) : null}
        {body.trim() && isWikiProduce ? (
          <pre className="okf-code-snippet max-h-32 overflow-auto text-[11px] leading-relaxed text-muted-foreground">
            {body}
          </pre>
        ) : null}
        {wikiDetails ? (
          <WikiProduceGatePanel details={wikiDetails} onResumeGate={onResumeGate} />
        ) : null}
        {isRunning && !body.trim() ? <p className="text-[11px] text-muted-foreground">…</p> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
