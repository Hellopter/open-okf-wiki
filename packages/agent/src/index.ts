/**
 * @okf-wiki/agent — Pi-native Operator Sessions and the real wiki_produce tool.
 *
 * Pi owns conversation and tool lifecycle. Core owns the Run Boundary.
 */

/** Re-export Core skill roots helper (single resolution algorithm lives in Core). */
export { resolveWikiSkillPaths } from "@okf-wiki/core";
/** Operator-facing redaction for server HTTP/SSE surfaces. */
export {
  redactErrorMessage,
  redactSensitiveText,
  redactSensitiveValue,
  sanitizeSummary,
} from "./redact/index.js";
export { shouldUsePiFixtureMode } from "./runtime/fixture-mode.js";
export { createOperatorFixtureModel } from "./runtime/model/fixture-model.js";
export {
  resolveWorkspacePiModel,
  testProviderConnection,
} from "./runtime/model/provider-model.js";
export { resolveModelSelection } from "./runtime/model/role-model.js";
export {
  type ExpandOperatorCommandResult,
  expandOperatorCommand,
  listOperatorCommands,
  type OperatorCommand,
} from "./session/operator-commands.js";
export {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSessionHistory,
  type OperatorSessionHistory,
  openOperatorSession,
  projectOperatorAgentMessages,
  projectOperatorAgentMessagesFromManager,
  projectOperatorHistoryFromManager,
  projectOperatorHistoryMessage,
} from "./session/operator-session.js";
export {
  type GateDecision,
  type GatePort,
  type GateRequest,
} from "./workflow/run-wiki.js";
