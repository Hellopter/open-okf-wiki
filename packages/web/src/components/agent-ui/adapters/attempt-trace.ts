import type { AttemptTraceEvent } from "@okf-wiki/contract";
import {
  inferToolKind,
  type ToolNameLabels,
  toolProductTitle,
  toolStatusLabel,
} from "./tool-labels.ts";
import type { ToolItemStatus, ToolItemVM } from "./types.ts";

export type AttemptToolCallEvent = Extract<AttemptTraceEvent, { kind: "tool_call" }>;
export type AttemptToolResultEvent = Extract<AttemptTraceEvent, { kind: "tool_result" }>;

function isOpenByDefault(status: ToolItemStatus, errorText?: string): boolean {
  return status === "pending" || status === "running" || status === "error" || Boolean(errorText);
}

/**
 * Pair an attempt-transcript tool_call with its optional tool_result into a ToolItemVM.
 * Either side may be missing (orphan result, or still-running call).
 */
export function attemptToolToViewModel(
  call?: AttemptToolCallEvent,
  result?: AttemptToolResultEvent,
  labels: ToolNameLabels = {},
): ToolItemVM {
  const name = call?.name ?? result?.name ?? "tool";
  const id =
    call?.toolCallId ??
    result?.toolCallId ??
    (call ? `call-${call.ordinal}` : result ? `result-${result.ordinal}` : "tool");

  let status: ToolItemStatus;
  if (!result) {
    status = "running";
  } else if (result.status === "error") {
    status = "error";
  } else {
    status = "done";
  }

  const inputText = call?.args;
  const outputText = result?.output;
  // Keep summary/output separate; item UI dedupes when summary equals error/output.
  const errorText = result?.status === "error" ? result.output : undefined;

  return {
    id,
    title: toolProductTitle(name, labels),
    technicalName: name,
    status,
    statusLabel: toolStatusLabel(status, labels),
    inputText,
    outputText,
    errorText,
    kind: inferToolKind(name),
    defaultOpen: isOpenByDefault(status, errorText),
    testId: `attempt-tool-${name}`,
  };
}
