import { closeOperatorSessions } from "./operator-sessions.ts";

export async function resetOperatorSessionsForTests(): Promise<void> {
  await closeOperatorSessions();
}
