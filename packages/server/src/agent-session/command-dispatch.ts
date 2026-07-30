/**
 * Operator Session command dispatch via SessionRuntime.
 * Plan/publication HITL is ResolveGate on WikiRuns (Run API), not a Session command.
 *
 * HTTP returns 202 after admission (acceptedTurnId); the turn runs detached.
 * Completion and provider errors project through Session SSE — never await the
 * full turn here.
 */

import type { AgentCommand, AgentCommandResponse, WorkspaceConfig } from "@okf-wiki/contract";
import { ensureRegistered } from "./live-session-registry.ts";
import { createSessionRuntime } from "./session-runtime.ts";

/** Delegate commands only to SessionRuntime over the real AgentSession. */
export async function dispatchAgentCommand(
  workspace: WorkspaceConfig,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  const entry = await ensureRegistered(workspace, sessionId);
  return createSessionRuntime(entry, workspace).dispatch(command);
}
