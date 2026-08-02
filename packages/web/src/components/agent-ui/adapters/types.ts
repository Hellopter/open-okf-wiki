export type ToolItemStatus = "pending" | "running" | "done" | "error";

export type ToolItemKind = "generic" | "wiki_produce" | "read" | "write" | "search";

export type ToolDetailLine = {
  text: string;
  tone?: "default" | "add" | "del" | "error" | "ok";
  mono?: boolean;
};

/** Field pair used only while building detail lines inside adapters. */
export type ToolItemField = { label: string; value: string };

/** Per-file edit stats for group footers (Beautiful UI file chips). */
export type ToolFileChange = {
  file: string;
  add: number;
  del: number;
};

/**
 * Chip-first view model for transcript / attempt tool rows.
 * Presentation is a single-line chip row — not a bordered card.
 */
export type ToolItemVM = {
  id: string;
  title: string;
  technicalName?: string;
  status: ToolItemStatus;
  kind: ToolItemKind;
  /** a11y / aria only — not rendered as a badge */
  statusLabel?: string;
  /** Pill content: path, command, pattern, short summary */
  chip?: string;
  chipMono?: boolean;
  /** Expanded left-rail lines (preferred over raw dumps) */
  detailLines?: ToolDetailLine[];
  /** Short summary when present on the wire */
  summary?: string;
  /** Fallback long payloads when detailLines can't carry them */
  inputText?: string;
  outputText?: string;
  errorText?: string;
  /** File edit stats derived from args/output (write/edit tools). */
  fileChange?: ToolFileChange;
  openRunId?: string;
  /** Only true for running/pending/error — NOT merely because args exist. */
  defaultOpen: boolean;
  testId?: string;
};
