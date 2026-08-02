import type { AgentToolCall } from "@okf-wiki/contract";
import {
  inferToolKind,
  type ToolNameLabels,
  toolProductTitle,
  toolStatusLabel,
} from "./tool-labels.ts";
import type { ToolItemStatus, ToolItemVM } from "./types.ts";

function formatArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

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

function isOpenByDefault(status: ToolItemStatus, errorText?: string): boolean {
  return status === "pending" || status === "running" || status === "error" || Boolean(errorText);
}

/** Project a live AgentToolCall into the shared tool row view model. */
export function agentToolCallToViewModel(
  tool: AgentToolCall,
  labels: ToolNameLabels = {},
): ToolItemVM {
  const status = tool.status as ToolItemStatus;
  const summary = tool.details?.summary;
  const inputText = formatArgs(tool.args);
  const outputText = tool.output;
  // Keep summary separate; item UI dedupes when summary equals error/output.
  const errorText = status === "error" ? tool.output : undefined;
  const openRunId = openRunIdFromTool(tool);

  return {
    id: tool.id,
    title: toolProductTitle(tool.name, labels),
    technicalName: tool.name,
    status,
    statusLabel: toolStatusLabel(status, labels),
    summary,
    inputText,
    outputText,
    errorText,
    kind: inferToolKind(tool.name),
    openRunId,
    defaultOpen: isOpenByDefault(status, errorText),
    testId: `agent-tool-${tool.name}`,
  };
}
