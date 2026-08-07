export {
  agentStatusGlyph,
  formatAgentDetail,
  formatAgentLine,
  formatAgentsTable,
  formatCoverageLine,
  formatDuration,
  formatPhasesLine,
  formatSnapshotText,
  isAgentStale,
  parseTimeMs,
  phaseStatusGlyph,
  type FormatTimeOpts,
} from "./format.js";

export { formatStatusBar } from "./status-bar.js";
export { formatFleetWidget } from "./widget.js";

export {
  applyInspectorKey,
  createInspectorState,
  filteredAgents,
  openWikiInspector,
  renderInspector,
  type InspectorKeyContext,
  type InspectorKeyResult,
  type InspectorPanel,
  type InspectorState,
  type OpenWikiInspectorContext,
  type OpenWikiInspectorOptions,
} from "./inspector.js";
