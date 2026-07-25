/**
 * @okf-wiki/agent — Pi-native Operator Sessions and the real wiki_produce tool.
 *
 * Pi owns conversation and tool lifecycle. Core owns the Run Boundary.
 */

/** Re-export Core skill roots helper (single resolution algorithm lives in Core). */
export { resolveWikiSkillPaths } from "@okf-wiki/core";
export { createOperatorFixtureModel } from "./pi/operator-fixture-model.js";
export {
  createOperatorSession,
  deleteOperatorSession,
  listOperatorSessions,
  loadOperatorSessionHistory,
  type OperatorSessionHistory,
  openOperatorSession,
  projectOperatorHistoryFromManager,
  projectOperatorHistoryMessage,
} from "./pi/operator-session.js";
/** Test seams: wrap Pi public SessionManager.appendMessage / history projection. */
export {
  injectDurableOperatorMessages as injectDurableOperatorMessagesForTests,
  readDurableOperatorBranchMessages as readDurableOperatorBranchMessagesForTests,
} from "./pi/operator-session-test-seams.js";
export {
  resolveWorkspacePiModel,
  testProviderConnection,
} from "./pi/provider-model.js";
export { resolveModelSelection } from "./pi/role-model.js";
export { shouldUsePiFixtureMode } from "./produce/fixture-mode.js";
export {
  type WikiProduceGateCoordinator,
  type WikiProduceGateDecision,
  type WikiProduceGateRequest,
} from "./produce/run-wiki.js";
/** Operator-facing redaction for server HTTP/SSE surfaces. */
export {
  redactErrorMessage,
  redactSensitiveText,
  redactSensitiveValue,
  sanitizeSummary,
} from "./run-redact.js";
