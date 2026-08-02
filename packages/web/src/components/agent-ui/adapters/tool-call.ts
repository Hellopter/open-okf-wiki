import type { AgentToolCall } from "@okf-wiki/contract";
import {
  extractPrimaryFields,
  extractToolHeadline,
  formatRawArgs,
  toolDefaultOpen,
} from "./tool-fields.ts";
import {
  inferToolKind,
  type ToolNameLabels,
  toolProductTitle,
  toolStatusLabel,
} from "./tool-labels.ts";
import type { ToolItemStatus, ToolItemVM } from "./types.ts";

function openRunIdFromTool(tool: AgentToolCall): string | undefined {
  if (tool.name === "wiki_produce") {
    const runId = tool.details?.runId;
    return typeof runId === "string" && runId.trim() ? runId : undefined;
  }
  if (tool.name === "wiki_repair" && tool.args && typeof tool.args === "object") {
    const runId = (tool.args as Record<string, unknown>).runId;
    return typeof runId === "string" && runId.trim() ? runId : undefined;
  }
  return undefined;
}

/** Project a live AgentToolCall into the shared tool row view model. */
export function agentToolCallToViewModel(
  tool: AgentToolCall,
  labels: ToolNameLabels = {},
): ToolItemVM {
  const status = tool.status as ToolItemStatus;
  const summary = tool.details?.summary;
  const inputText = formatRawArgs(tool.args);
  const outputText = tool.output;
  // Keep summary separate; item UI dedupes when summary equals error/output.
  const errorText = status === "error" ? tool.output : undefined;
  const openRunId = openRunIdFromTool(tool);
  const headline = extractToolHeadline(tool.args, tool.details);
  const primaryFields = extractPrimaryFields(tool.args);

  return {
    id: tool.id,
    title: toolProductTitle(tool.name, labels),
    technicalName: tool.name,
    status,
    statusLabel: toolStatusLabel(status, labels),
    summary,
    headline,
    primaryFields,
    inputText,
    outputText,
    errorText,
    kind: inferToolKind(tool.name),
    openRunId,
    defaultOpen: toolDefaultOpen(status),
    testId: `agent-tool-${tool.name}`,
  };
}
