/** Agent UI chrome — Beautiful-UI-inspired patterns on shadcn + semantic tokens. */

export {
  type StatusTone,
  type StatusMotion,
  type StatusDescriptor,
  type StatusKind,
  STATUS_TONE_TEXT,
  statusToneTextClass,
  describeToolStatus,
  describeRunStatus,
  describeNodeStatus,
  describeConnectionStatus,
  describeAttemptStatus,
  describeStatus,
} from "./status";

export { StatusGlyph, type StatusGlyphProps } from "./StatusGlyph";
export { StatusBadge, type StatusBadgeProps } from "./StatusBadge";
export { ActivityCollapsible, type ActivityCollapsibleProps } from "./ActivityCollapsible";
export { CodeSurface, type CodeSurfaceProps } from "./CodeSurface";
export { ThinkingDisclosure, type ThinkingDisclosureProps } from "./ThinkingDisclosure";
export { ToolExecutionItem, type ToolExecutionItemProps } from "./ToolExecutionItem";
export { ToolExecutionGroup, type ToolExecutionGroupProps } from "./ToolExecutionGroup";
export { AgentTaskRow, type AgentTaskRowProps } from "./AgentTaskRow";
export { GateActionShell, type GateActionShellProps } from "./GateActionShell";
export { DiffSurface, type DiffSurfaceProps } from "./DiffSurface";

export type { ToolItemStatus, ToolItemKind, ToolItemVM } from "./adapters/types";
export {
  type ToolNameLabels,
  toolProductTitle,
  toolStatusLabel,
  inferToolKind,
} from "./adapters/tool-labels";
export { agentToolCallToViewModel } from "./adapters/tool-call";
export {
  type AttemptToolCallEvent,
  type AttemptToolResultEvent,
  attemptToolToViewModel,
} from "./adapters/attempt-trace";
