export type ToolItemStatus = "pending" | "running" | "done" | "error";

export type ToolItemKind = "generic" | "wiki_produce" | "read" | "write" | "search";

export type ToolItemVM = {
  id: string;
  title: string;
  technicalName?: string;
  status: ToolItemStatus;
  /** Localized status badge label; falls back to raw `status` when omitted. */
  statusLabel?: string;
  summary?: string;
  inputText?: string;
  outputText?: string;
  errorText?: string;
  kind?: ToolItemKind;
  openRunId?: string;
  defaultOpen: boolean;
  testId?: string;
};
