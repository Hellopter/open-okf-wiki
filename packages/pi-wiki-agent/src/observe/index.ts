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

export {
  applyInspectorKey,
  createInspectorState,
  openWikiInspector,
  renderInspector,
  type InspectorKeyResult,
  type InspectorPanel,
  type InspectorRenderOptions,
  type InspectorState,
  type OpenWikiInspectorContext,
  type OpenWikiInspectorOptions,
} from "./inspector.js";
