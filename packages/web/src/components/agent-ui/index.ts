/** Agent UI chrome — Beautiful-UI-inspired patterns on shadcn + semantic tokens. */

export { ActivityCollapsible, type ActivityCollapsibleProps } from "./ActivityCollapsible";
export { AgentTaskRow, type AgentTaskRowProps } from "./AgentTaskRow";
export {
  type AttemptToolCallEvent,
  type AttemptToolResultEvent,
  attemptToolToViewModel,
} from "./adapters/attempt-trace";
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
export {
  ComposerSessionChrome,
  type ComposerSessionChromeProps,
} from "./ComposerSessionChrome";
export {
  AttemptContextSummary,
  type AttemptContextSummaryLabels,
  type AttemptContextSummaryProps,
} from "./context/AttemptContextSummary";
export {
  type AttemptTokenSideNote,
  type AttemptUsageFields,
  contextPhaseFromAttemptUsage,
  formatAttemptTokenSideNote,
  formatNodeContextHoverTitle,
  isCapacityFailure,
  latestAttemptOnNode,
  type NodeContextFillSummary,
  nodeContextFillSummary,
  sessionUsageFromAttempt,
  stageContextFillSummary,
  type StageNodeRef,
  usageFieldsFromMetricsExtra,
} from "./context/attempt-usage";
export {
  ContextFillDetail,
  type ContextFillDetailLabels,
  type ContextFillDetailProps,
} from "./context/ContextFillDetail";
export { ContextFillMeter, type ContextFillMeterProps } from "./context/ContextFillMeter";
export {
  ContextFillMicroDot,
  type ContextFillMicroDotProps,
} from "./context/ContextFillMicroDot";
export {
  contextPhaseRingClass,
  contextPhaseTextClass,
  contextPhaseTone,
  isContextNearLimit,
} from "./context/context-phase";
export {
  CONTROL_SLASH_COMMANDS,
  filterSlashCommands,
  insertSlashCommand,
  isCompactSlashPrompt,
  isControlSlashPrompt,
  isSlashCommandPrompt,
  mergeSlashCommands,
  planSessionSend,
  slashCommandName,
  type SlashCommandOption,
} from "./context/slash-commands";
export { DiffSurface, type DiffSurfaceProps } from "./DiffSurface";
export { GateActionShell, type GateActionShellProps } from "./GateActionShell";
export { ModelChip, type ModelChipProps } from "./ModelChip";
export { ModelPicker, type ModelPickerProps } from "./ModelPicker";
export { SlashCommandList, type SlashCommandListProps } from "./SlashCommandList";
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
