/**
 * Thin re-export facade for the agent-session live registry.
 * Logic lives under `./agent-session/*` — this path stays stable for routes/tests.
 */

export type { AgentSessionHistoryLoad, LiveAgentSessionSummary } from "./agent-session/index.ts";
export {
  ageLiveSessionForTests,
  composeSessionUsage,
  deleteAgentSession,
  dispatchAgentCommand,
  emitProductSseForTests,
  ensureRegistered,
  evictLiveAgentSessionForTests,
  getActiveAgentSessionTool,
  getAgentSessionUsage,
  injectDurableMessagesForTests,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  markLiveSessionBusyForTests,
  registerAgentSession,
  resetAgentSessionRegistryForTests,
  sessionUsageFromPiEvent,
  sessionUsageFromPiRows,
  setLiveSessionIdleTtlForTests,
  sweepIdleLiveSessions,
} from "./agent-session/index.ts";
