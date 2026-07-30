/**
 * Public surface for the Pi-native Operator Session live registry (ADR 0032).
 * Prefer importing from here or the thin `agent-session-registry.ts` facade.
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
  type AcceptedTurn,
  type CancelScope,
  type CompactOptions,
  createSessionRuntime,
  type Delivery,
  type SessionProjection,
  type SessionRuntime,
  snapshotSession,
} from "./session-runtime.ts";
export {
  type AgentSessionHistoryLoad,
  deleteAgentSession,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  registerAgentSession,
} from "./session-lifecycle.ts";
export {
  composeSessionUsage,
  contextBudgetFields,
  sessionUsageFromPiEvent,
  sessionUsageFromPiRows,
} from "./session-usage.ts";

export {
  ageLiveSessionForTests,
  emitProductSseForTests,
  evictLiveAgentSessionForTests,
  injectDurableMessagesForTests,
  markLiveSessionBusyForTests,
  resetAgentSessionRegistryForTests,
  setLiveSessionIdleTtlForTests,
} from "./test-seams.ts";
