/** Stable map key for one Operator Session live entry / event bus. */
export function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}::${sessionId}`;
}
