/**
 * Thin re-export facade for the agent-session live registry.
 * Logic lives under `./agent-session/*` — this path stays stable for routes/tests.
 */

export type { LiveAgentSessionSummary } from "./agent-session/index.ts";
export {
  ageLiveSessionForTests,
  deleteAgentSession,
  dispatchAgentCommand,
  emitProductSseForTests,
  ensureRegistered,
  evictLiveAgentSessionForTests,
  getActiveAgentSessionTool,
  injectDurableMessagesForTests,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  markLiveSessionBusyForTests,
  registerAgentSession,
  resetAgentSessionRegistryForTests,
  setLiveSessionIdleTtlForTests,
  sweepIdleLiveSessions,
} from "./agent-session/index.ts";
