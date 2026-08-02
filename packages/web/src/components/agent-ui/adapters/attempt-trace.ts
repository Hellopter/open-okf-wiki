import type { AttemptTraceEvent } from "@okf-wiki/contract";
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

export type AttemptToolCallEvent = Extract<AttemptTraceEvent, { kind: "tool_call" }>;
export type AttemptToolResultEvent = Extract<AttemptTraceEvent, { kind: "tool_result" }>;

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

  // attempt call.args is typically a JSON string — parse for headline/fields, keep raw pretty.
  const rawArgs = call?.args;
  const inputText = rawArgs !== undefined ? formatRawArgs(rawArgs) : undefined;
  const outputText = result?.output;
  // Keep summary/output separate; item UI dedupes when summary equals error/output.
  const errorText = result?.status === "error" ? result.output : undefined;
  const headline = extractToolHeadline(rawArgs);
  const primaryFields = extractPrimaryFields(rawArgs);

  return {
    id,
    title: toolProductTitle(name, labels),
    technicalName: name,
    status,
    statusLabel: toolStatusLabel(status, labels),
    headline,
    primaryFields,
    inputText,
    outputText,
    errorText,
    kind: inferToolKind(name),
    defaultOpen: toolDefaultOpen(status),
    testId: `attempt-tool-${name}`,
  };
}
