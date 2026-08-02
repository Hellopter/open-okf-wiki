export type ToolItemStatus = "pending" | "running" | "done" | "error";

export type ToolItemKind = "generic" | "wiki_produce" | "read" | "write" | "search";

export type ToolItemField = { label: string; value: string };

export type ToolItemVM = {
  id: string;
  title: string;
  technicalName?: string;
  status: ToolItemStatus;
  /** Localized status badge label; falls back to raw `status` when omitted. */
  statusLabel?: string;
  summary?: string;
  /** One-line subtitle under title (path, pattern, short summary). */
  headline?: string;
  /** Compact key/value fields shown when expanded (not raw dumps). */
  primaryFields?: ToolItemField[];
  /** Raw args dump — only shown under secondary "Raw" collapsible when expanded. */
  inputText?: string;
  /** Raw output dump — only shown under secondary "Raw" collapsible when expanded. */
  outputText?: string;
  errorText?: string;
  kind?: ToolItemKind;
  openRunId?: string;
  /** Only true for running/error — NOT merely because args exist. */
  defaultOpen: boolean;
  testId?: string;
};
