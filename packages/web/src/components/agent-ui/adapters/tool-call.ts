import type { AgentToolCall } from "@okf-wiki/contract";
import {
  extractFileChange,
  extractToolChip,
  extractToolDetailLines,
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

/** Project a live AgentToolCall into the shared chip-row view model. */
export function agentToolCallToViewModel(
  tool: AgentToolCall,
  labels: ToolNameLabels = {},
): ToolItemVM {
  const status = tool.status as ToolItemStatus;
  const summary = tool.details?.summary;
  const inputText = formatRawArgs(tool.args);
  const outputText = tool.output;
  const errorText = status === "error" ? tool.output : undefined;
  const openRunId = openRunIdFromTool(tool);
  const kind = inferToolKind(tool.name);
  const chip = extractToolChip(tool.args, tool.details);
  const detailLines = extractToolDetailLines(tool.args, tool.details, {
    status,
    summary,
    output: outputText,
    errorText,
    chipText: chip?.text,
  });
  const fileChange =
    status === "error" ? undefined : extractFileChange(tool.args, outputText, kind);

  return {
    id: tool.id,
    title: toolProductTitle(tool.name, labels),
    technicalName: tool.name,
    status,
    statusLabel: toolStatusLabel(status, labels),
    summary,
    chip: chip?.text,
    chipMono: chip?.mono,
    detailLines,
    inputText,
    outputText,
    errorText,
    ...(fileChange ? { fileChange } : {}),
    kind,
    openRunId,
    defaultOpen: toolDefaultOpen(status),
    testId: `agent-tool-${tool.name}`,
  };
}
