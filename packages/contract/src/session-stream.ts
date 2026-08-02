/**
 * Browser-safe Operator Session projection (ADR 0039).
 *
 * This is deliberately separate from AgentMessage/PiStreamState. Pi messages
 * may contain provider thinking, tool arguments/results, system rows, and
 * filesystem details; none of those fields are representable on this wire.
 */

import { z } from "zod";
import { ContextPhaseSchema, PiAgentStatusSchema } from "./agent-stream.js";
import { SessionUsageSchema } from "./session-usage.js";
import { WikiProduceToolDetailsSchema } from "./wiki-produce.js";

export const SessionMessageRoleSchema = z.enum(["user", "assistant"]);
export type SessionMessageRole = z.infer<typeof SessionMessageRoleSchema>;

export const SessionMessageStatusSchema = z.enum(["streaming", "done", "error", "aborted"]);
export type SessionMessageStatus = z.infer<typeof SessionMessageStatusSchema>;

/** Safe lifecycle data for one tool call. Raw arguments and results never cross this DTO. */
export const SessionToolSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
    status: z.enum(["pending", "running", "done", "error"]),
    /** Bounded durable Run receipt, when the tool is wiki_produce. */
    receipt: WikiProduceToolDetailsSchema.optional(),
  })
  .strict();
export type SessionTool = z.infer<typeof SessionToolSchema>;

/** Browser-visible Session message. No thinking, parts, raw tools, or system rows. */
export const SessionMessageSchema = z
  .object({
    id: z.string().min(1),
    role: SessionMessageRoleSchema,
    content: z.string(),
    createdAt: z.string().min(1),
    tools: z.array(SessionToolSchema).optional(),
    status: SessionMessageStatusSchema.optional(),
    errorText: z.string().optional(),
  })
  .strict();
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

/** Complete browser Session state; snapshots always carry this whole object. */
export const SessionStreamStateSchema = z
  .object({
    messages: z.array(SessionMessageSchema),
    streamingMessage: SessionMessageSchema.nullable(),
    lastAssistantId: z.string().nullable(),
    turnActive: z.boolean(),
    agentStatus: PiAgentStatusSchema,
    errorText: z.string().nullable(),
    contextPhase: ContextPhaseSchema,
    sessionUsage: SessionUsageSchema.optional(),
  })
  .strict();
export type SessionStreamState = z.infer<typeof SessionStreamStateSchema>;

/** Incremental patch between two browser-safe Session states. */
export const SessionStreamPatchSchema = z
  .object({
    agentStatus: PiAgentStatusSchema,
    errorText: z.string().nullable(),
    turnActive: z.boolean(),
    lastAssistantId: z.string().nullable(),
    streamingMessage: SessionMessageSchema.nullable(),
    appended: z.array(SessionMessageSchema),
    updated: z.array(SessionMessageSchema),
    contextPhase: ContextPhaseSchema,
    /** Absent leaves prior usage intact; present replaces it. */
    sessionUsage: SessionUsageSchema.optional(),
  })
  .strict();
export type SessionStreamPatch = z.infer<typeof SessionStreamPatchSchema>;

export function createSessionStreamState(seed: readonly SessionMessage[] = []): SessionStreamState {
  let lastAssistantId: string | null = null;
  for (let index = seed.length - 1; index >= 0; index -= 1) {
    if (seed[index]?.role === "assistant") {
      lastAssistantId = seed[index]!.id;
      break;
    }
  }
  return {
    messages: seed.slice(),
    streamingMessage: null,
    lastAssistantId,
    turnActive: false,
    agentStatus: "idle",
    errorText: null,
    contextPhase: "unknown",
  };
}

function messageFingerprint(message: SessionMessage): string {
  return JSON.stringify(message);
}

/** Diff two complete Session projections for the SSE live path. */
export function diffSessionStreamState(
  previous: SessionStreamState,
  next: SessionStreamState,
): SessionStreamPatch {
  const previousById = new Map(previous.messages.map((message) => [message.id, message]));
  const appended: SessionMessage[] = [];
  const updated: SessionMessage[] = [];
  for (const message of next.messages) {
    const prior = previousById.get(message.id);
    if (!prior) appended.push(message);
    else if (messageFingerprint(prior) !== messageFingerprint(message)) updated.push(message);
  }
  return {
    agentStatus: next.agentStatus,
    errorText: next.errorText,
    turnActive: next.turnActive,
    lastAssistantId: next.lastAssistantId,
    streamingMessage: next.streamingMessage,
    appended,
    updated,
    contextPhase: next.contextPhase,
    ...(next.sessionUsage ? { sessionUsage: next.sessionUsage } : {}),
  };
}

/** Apply a server Session patch. Client-only optimistic rows retain their order. */
export function applySessionStreamPatch(
  state: SessionStreamState,
  patch: SessionStreamPatch,
): SessionStreamState {
  const byId = new Map(state.messages.map((message) => [message.id, message]));
  for (const message of patch.updated) byId.set(message.id, message);
  for (const message of patch.appended) byId.set(message.id, message);

  const seen = new Set<string>();
  const messages: SessionMessage[] = [];
  for (const message of state.messages) {
    const next = byId.get(message.id);
    if (next) {
      messages.push(next);
      seen.add(message.id);
    }
  }
  for (const message of [...patch.updated, ...patch.appended]) {
    if (!seen.has(message.id)) {
      messages.push(message);
      seen.add(message.id);
    }
  }

  return {
    messages,
    streamingMessage: patch.streamingMessage,
    lastAssistantId: patch.lastAssistantId,
    turnActive: patch.turnActive,
    agentStatus: patch.agentStatus,
    errorText: patch.errorText,
    contextPhase: patch.contextPhase,
    ...(patch.sessionUsage
      ? { sessionUsage: patch.sessionUsage }
      : state.sessionUsage
        ? { sessionUsage: state.sessionUsage }
        : {}),
  };
}

export function viewSessionMessages(state: SessionStreamState): SessionMessage[] {
  return state.streamingMessage ? [...state.messages, state.streamingMessage] : state.messages;
}
