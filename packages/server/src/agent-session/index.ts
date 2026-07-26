/**
 * Public surface for the Pi-native Operator Session live registry (ADR 0032).
 * Prefer importing from here or the thin `agent-session-registry.ts` facade.
 */

export { dispatchAgentCommand } from "./command-dispatch.ts";
export type { LiveAgentSessionSummary } from "./live-session-registry.ts";
export {
  ensureRegistered,
  getActiveAgentSessionTool,
  sweepIdleLiveSessions,
} from "./live-session-registry.ts";
export {
  deleteAgentSession,
  listLiveAgentSessionSummaries,
  loadAgentSessionHistory,
  registerAgentSession,
} from "./session-lifecycle.ts";

export {
  ageLiveSessionForTests,
  emitProductSseForTests,
  evictLiveAgentSessionForTests,
  injectDurableMessagesForTests,
  markLiveSessionBusyForTests,
  resetAgentSessionRegistryForTests,
  setLiveSessionIdleTtlForTests,
} from "./test-seams.ts";
