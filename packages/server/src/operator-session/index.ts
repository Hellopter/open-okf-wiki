/**
 * Minimal live host for Pi-backed Operator Sessions.
 *
 * Pi's SessionManager remains the durable conversation store and WikiRuns
 * remains the durable workflow store. This package only owns live handles and
 * projects genuine Pi events to the browser.
 *
 * Public surface for routes/main — keep imports stable via ../operator-sessions.ts.
 */

export { dispatchSessionCommand } from "./commands.ts";
export {
  createLiveSession,
  deleteLiveSession,
  listSessions,
  sessionSnapshot,
  subscribeSession,
} from "./lifecycle.ts";
export {
  projectOperatorMessage,
  projectOperatorStreamState,
  type OperatorStreamChrome,
} from "./project.ts";
export {
  closeOperatorSessions,
  invalidateOperatorSessions,
  restoreOperatorSessionsAfterFailedWorkspaceDeletion,
  retireOperatorSessionsForDeletedWorkspace,
} from "./registry.ts";
export { OperatorSessionWorkspaceDeletedError } from "./workspace-guard.ts";
