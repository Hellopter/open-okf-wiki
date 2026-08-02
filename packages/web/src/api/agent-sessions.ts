/** Browser transport for Pi-native Operator Sessions. */
import type {
  AgentCommand,
  AgentCommandResponse,
  AgentSseEvent,
  CreatePiAgentSessionBody,
  CreatePiAgentSessionResponse,
  PiSessionSummary,
} from "@okf-wiki/contract";
import { AgentSseEventSchema } from "@okf-wiki/contract";
import { z } from "zod";
import { getApiBase, request } from "./client";

export type {
  AgentCommand,
  AgentCommandResponse,
  AgentSseEvent,
  CreatePiAgentSessionBody,
  CreatePiAgentSessionResponse,
  PiSessionSummary,
};

export type OperatorCommandInfo = { name: string; description: string; argumentHint?: string };

const OperatorCommandsSchema = z.object({
  commands: z.array(
    z.object({ name: z.string(), description: z.string(), argumentHint: z.string().optional() }),
  ),
});
const SessionListSchema = z.object({
  sessions: z.array(
    z.object({ id: z.string(), title: z.string().optional(), updatedAt: z.string().optional() }),
  ),
});
const CreateSessionSchema = z.object({
  session: z.object({
    id: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    createdAt: z.string(),
  }),
});
const DeleteSessionSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string(),
  removed: z.number(),
});
const SessionCommandSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string(),
  command: z.enum([
    "prompt",
    "steer",
    "follow_up",
    "abort",
    "clear_queue",
    "abort_compaction",
    "compact",
    "set_model",
  ]),
  status: z.enum(["accepted", "failed"]),
  message: z.string().optional(),
  runId: z.string().optional(),
  modelId: z.string().optional(),
  acceptedTurnId: z.string().optional(),
});

export function listOperatorCommands(): Promise<{ commands: OperatorCommandInfo[] }> {
  return request("/api/agent/commands").then(OperatorCommandsSchema.parse);
}

export function listAgentSessions(
  workspaceId: string,
  init?: Pick<RequestInit, "signal">,
): Promise<{ sessions: PiSessionSummary[] }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions`, init).then(
    SessionListSchema.parse,
  );
}

export function createAgentSession(
  workspaceId: string,
  input?: CreatePiAgentSessionBody,
): Promise<CreatePiAgentSessionResponse> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }).then(CreateSessionSchema.parse);
}

export function deleteAgentSession(
  workspaceId: string,
  sessionId: string,
): Promise<{ ok: boolean; sessionId: string; removed: number }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE" },
  ).then(DeleteSessionSchema.parse);
}

export function agentSessionCommand(
  workspaceId: string,
  sessionId: string,
  command: AgentCommand,
): Promise<AgentCommandResponse> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/command`,
    { method: "POST", body: JSON.stringify(command) },
  ).then(SessionCommandSchema.parse);
}

export function agentSessionEventsUrl(workspaceId: string, sessionId: string): string {
  return `${getApiBase()}/api/workspaces/${encodeURIComponent(workspaceId)}/agent/sessions/${encodeURIComponent(sessionId)}/events`;
}

export function parseAgentSessionEvent(data: string): AgentSseEvent {
  return AgentSseEventSchema.parse(JSON.parse(data));
}
