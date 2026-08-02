import { closeOperatorSessions } from "./operator-sessions.ts";

export function resetOperatorSessionsForTests(): void {
  closeOperatorSessions();
}
