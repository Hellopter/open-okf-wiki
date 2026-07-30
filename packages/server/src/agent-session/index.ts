/**
 * Public surface for the Pi-native Operator Session live registry (ADR 0032).
 */

export { dispatchAgentCommand } from "./command-dispatch.ts";
export type { LiveAgentSessionSummary } from "./live-session-registry.ts";
export {
  ensureRegistered,
  getActiveAgentSessionTool,
  getAgentSessionUsage,
  sweepIdleLiveSessions,
} from "./live-session-registry.ts";
export {
  type AgentSessionHistoryLoad,
  deleteAgentSession,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  registerAgentSession,
} from "./session-lifecycle.ts";
export {
  type AcceptedTurn,
  type CancelScope,
  type CompactOptions,
  type Delivery,
  type SessionProjection,
  type SessionRuntime,
} from "./session-runtime.ts";
export {
  composeSessionUsage,
  contextBudgetFields,
  sessionUsageFromPiEvent,
  sessionUsageFromPiRows,
} from "./session-usage.ts";
