/**
 * Pi Agent Workspace HTTP / EventSource API (ADR 0030).
 * Routes match packages/server/src/routes/agent-sessions.ts.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  AgentCommand,
  AgentCommandResponse,
  CreatePiAgentSessionBody,
  CreatePiAgentSessionResponse,
  PiSessionSummary,
} from "@okf-wiki/contract";
import { getApiBase, request } from "./client";

export type {
  AgentCommand,
  AgentCommandResponse,
  CreatePiAgentSessionBody,
  CreatePiAgentSessionResponse,
  PiSessionSummary,
};

export type OperatorCommandInfo = {
  name: string;
  description: string;
  argumentHint?: string;
};

/** Operator slash-command registry for composer autocomplete. */
export function listOperatorCommands(): Promise<{ commands: OperatorCommandInfo[] }> {
  return request<{ commands: OperatorCommandInfo[] }>("/api/agent/commands");
}

/** List Pi agent sessions under `.okf-wiki/pi-sessions/`. */
export function listAgentSessions(workspaceId: string): Promise<{ sessions: PiSessionSummary[] }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions`);
}

/** Create a live Pi Operator Session; Pi persists it on the first completed turn. */
export function createAgentSession(
  workspaceId: string,
  input?: CreatePiAgentSessionBody,
): Promise<CreatePiAgentSessionResponse> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

/** Delete a Pi Operator Session and its associated Wiki Run work data. */
export function deleteAgentSession(
  workspaceId: string,
  sessionId: string,
): Promise<{ ok: boolean; sessionId: string; removed: number }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    },
  );
}

/**
 * POST a native AgentSession command (prompt | steer | abort | compact).
 */
export function agentSessionCommand(
  workspaceId: string,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/command`,
    {
      method: "POST",
      body: JSON.stringify(command),
    },
  );
}

/** Absolute EventSource URL for snapshot + genuine Pi events. */
export function agentSessionEventsUrl(workspaceId: string, sessionId: string): string {
  return `${getApiBase()}/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/events`;
}
