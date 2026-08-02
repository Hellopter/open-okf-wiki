/** Agent UI chrome — Beautiful-UI-inspired patterns on shadcn + semantic tokens. */

export { ActivityCollapsible, type ActivityCollapsibleProps } from "./ActivityCollapsible";
export { AgentTaskRow, type AgentTaskRowProps } from "./AgentTaskRow";
export {
  AssistantTurn,
  type AssistantTurnLabels,
  type AssistantTurnProps,
} from "./AssistantTurn";
export {
  type AttemptToolCallEvent,
  type AttemptToolResultEvent,
  attemptToolToViewModel,
} from "./adapters/attempt-trace";
export { agentToolCallToViewModel } from "./adapters/tool-call";
export {
  aggregateFileChanges,
  countUnifiedDiffStats,
  extractFileChange,
  extractPrimaryFields,
  extractToolChip,
  extractToolDetailLines,
  formatRawArgs,
  parseToolArgs,
  toolDefaultOpen,
} from "./adapters/tool-fields";
export {
  inferToolKind,
  type ToolNameLabels,
  toolProductTitle,
  toolStatusLabel,
} from "./adapters/tool-labels";
export type {
  ToolDetailLine,
  ToolFileChange,
  ToolItemField,
  ToolItemKind,
  ToolItemStatus,
  ToolItemVM,
} from "./adapters/types";
export { CodeSurface, type CodeSurfaceProps } from "./CodeSurface";
export { DiffSurface, type DiffSurfaceProps } from "./DiffSurface";
export { GateActionShell, type GateActionShellProps } from "./GateActionShell";
export { StatusBadge, type StatusBadgeProps } from "./StatusBadge";
export { StatusGlyph, type StatusGlyphProps } from "./StatusGlyph";
export {
  describeAttemptStatus,
  describeConnectionStatus,
  describeNodeStatus,
  describeRunStatus,
  describeStatus,
  describeToolStatus,
  STATUS_TONE_TEXT,
  type StatusDescriptor,
  type StatusKind,
  type StatusMotion,
  type StatusTone,
  statusToneTextClass,
} from "./status";
export { ThinkingDisclosure, type ThinkingDisclosureProps } from "./ThinkingDisclosure";
export { ToolChipGroup, type ToolChipGroupProps } from "./ToolChipGroup";
export { ToolChipRow, type ToolChipRowProps } from "./ToolChipRow";
export { ToolKindIcon, type ToolKindIconProps } from "./tool-kind-icon";
