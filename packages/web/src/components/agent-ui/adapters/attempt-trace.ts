import type { AttemptTraceEvent } from "@okf-wiki/contract/wiki-runs";
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

  const kind = inferToolKind(name);
  const rawArgs = call?.args;
  const inputText = rawArgs !== undefined ? formatRawArgs(rawArgs) : undefined;
  const outputText = result?.output;
  const errorText = result?.status === "error" ? result.output : undefined;
  const chip = extractToolChip(rawArgs);
  const detailLines = extractToolDetailLines(rawArgs, undefined, {
    status,
    output: outputText,
    errorText,
    chipText: chip?.text,
  });
  const fileChange =
    status === "error" ? undefined : extractFileChange(rawArgs, outputText, kind);

  return {
    id,
    title: toolProductTitle(name, labels),
    technicalName: name,
    status,
    statusLabel: toolStatusLabel(status, labels),
    chip: chip?.text,
    chipMono: chip?.mono,
    detailLines,
    inputText,
    outputText,
    errorText,
    ...(fileChange ? { fileChange } : {}),
    kind,
    defaultOpen: toolDefaultOpen(status),
    testId: `attempt-tool-${name}`,
  };
}
