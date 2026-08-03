/**
 * Compatibility barrel for Operator Sessions.
 *
 * Implementation lives under `./operator-session/`. Routes and main keep
 * importing this path so existing import sites stay stable.
 */
export {
  closeOperatorSessions,
  createLiveSession,
  deleteLiveSession,
  dispatchSessionCommand,
  invalidateOperatorSessions,
  listSessions,
  OperatorSessionWorkspaceDeletedError,
  type OperatorStreamChrome,
  projectOperatorMessage,
  projectOperatorStreamState,
  restoreOperatorSessionsAfterFailedWorkspaceDeletion,
  retireOperatorSessionsForDeletedWorkspace,
  sessionSnapshot,
  subscribeSession,
} from "./operator-session/index.ts";
