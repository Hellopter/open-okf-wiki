/**
 * @okf-wiki/agent — Pi-native Operator Sessions and thin wiki_produce / wiki_repair tools.
 *
 * Pi owns conversation and tool lifecycle. Core owns the Run Boundary.
 * WikiRuns (workflow package, composed by server) owns durable Run control.
 * wiki_produce dispatches StartRun and returns a receipt; it does not own the Run.
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
  type CreatePiAttemptExecutorOptions,
  createPiAttemptExecutor,
  type PiAttemptExecutor,
} from "./runtime/pi-attempt-executor.js";
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
  type CreateWikiProduceToolInput,
  createWikiProduceTool,
  type StartWikiRun,
  WIKI_PRODUCE_TOOL_NAME,
} from "./tools/wiki-produce.js";
export {
  type CreateWikiRepairToolInput,
  createWikiRepairTool,
  type RerunWikiNode,
  WIKI_REPAIR_TOOL_NAME,
  type WikiRepairToolDetails,
} from "./tools/wiki-repair.js";
