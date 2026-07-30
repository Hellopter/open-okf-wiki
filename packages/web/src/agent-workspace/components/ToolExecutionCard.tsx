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
 *
 * wiki_produce: tool details only expose accepted+runId (StartRun receipt).
 * Live Run status / gates / graph come from WikiRuns via the panel — never
 * treat long-running tool phase strings as control-plane truth.
 */

import { ChevronRightIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatMessage, useI18n } from "../../i18n";
import { formatToolResultText } from "../hooks/project/format";
import type { AgentToolCall } from "../hooks/project/types";
import { DiffPreview } from "./tool-display/DiffPreview";
import { ToolStatusGlyph } from "./tool-display/glyphs";
import { toolIcon, WIKI_PRODUCE_TOOL_NAME } from "./tool-display/icons";
import { formatToolDisplay } from "./tool-display/summary";
import { WikiProduceGatePanel } from "./WikiProduceGatePanel";

export type ToolExecutionCardProps = {
  tool: AgentToolCall;
  /**
   * When the parent work unit is settled, keep completed tools collapsed.
   * Pass `false` while a unit is still active so non-done tools expand.
   */
  settled?: boolean;
};

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

// Memoized: settled tool rows keep object identity across stream ticks, so
// only the actively-updating tool re-renders (formatToolResultText can walk
// multi-KB outputs on every tick otherwise).
export const ToolExecutionCard = memo(function ToolExecutionCard({
  tool,
  settled,
}: ToolExecutionCardProps) {
  const { t } = useI18n();
  const display = formatToolDisplay(tool.name, tool.args);
  const output = formatToolResultText(tool.output) ?? "";
  const isError = tool.status === "error";
  const isRunning = tool.status === "running" || tool.status === "pending";
  const isWikiProduce = tool.name.toLowerCase() === WIKI_PRODUCE_TOOL_NAME;
  const wikiDetails = isWikiProduce ? tool.details : undefined;
  // accepted+runId receipt — keep the card open so the operator can see the
  // handoff; HITL lives on the Active Run bar, not this card.
  const wikiRunHandoff = Boolean(wikiDetails?.runId);

  const body = expandBody(display.kind, {
    writePreview: display.writePreview,
    output,
  });

  const canExpand =
    Boolean(wikiDetails) ||
    (!display.headerOnly &&
      (Boolean(body.trim()) ||
        isError ||
        (display.kind === "write-body" && Boolean(display.writePreview || display.diff))));

  const autoOpen =
    isRunning ||
    isError ||
    wikiRunHandoff ||
    (settled === false && tool.status !== "done" && canExpand);

  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  const Icon = toolIcon(tool.name);

  // Claude-style result summary on the trigger line ("· 42 lines").
  const resultLineCount =
    tool.status === "done" && display.kind === "output-only" && output.trim()
      ? output.replace(/\n$/, "").split("\n").length
      : 0;

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
      <ToolStatusGlyph status={tool.status} />
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
        {isWikiProduce && wikiDetails?.status === "accepted" && wikiDetails.runId ? (
          <span className="ml-1.5 font-mono text-2xs text-muted-foreground">
            {wikiDetails.runId.length > 12
              ? `${wikiDetails.runId.slice(0, 8)}…`
              : wikiDetails.runId}
          </span>
        ) : display.subtitle ? (
          <span
            className={cn(
              "ml-1.5 text-muted-foreground",
              display.subtitleMono && "font-mono text-2xs",
            )}
          >
            {display.subtitle}
          </span>
        ) : null}
        {display.args?.map((arg) => (
          <span key={arg} className="ml-1.5 font-mono text-2xs text-muted-foreground/80">
            {arg}
          </span>
        ))}
        {resultLineCount > 0 ? (
          <span className="ml-1.5 text-2xs text-muted-foreground/70">
            {formatMessage(t.agentWorkspace.toolResultLines, { n: resultLineCount })}
          </span>
        ) : null}
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
      data-wiki-run-id={wikiDetails?.runId}
    >
      <CollapsibleTrigger className="w-full min-w-0 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {trigger}
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0 overflow-hidden pl-4 pr-1 pb-1.5 sm:pl-6">
        {/* wiki_produce: structured panel only — never dump body pre + details twice. */}
        {wikiDetails ? (
          <WikiProduceGatePanel details={wikiDetails} />
        ) : display.diff ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <DiffPreview removed={display.diff.removed} added={display.diff.added} />
            {output.trim() ? (
              <pre className={cn("okf-code-snippet", isError && "text-destructive")}>{output}</pre>
            ) : null}
          </div>
        ) : body.trim() ? (
          <pre className={cn("okf-code-snippet", isError && "text-destructive")}>{body}</pre>
        ) : isRunning ? (
          <p className="text-2xs text-muted-foreground">…</p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
});
