/**
 * Pi Operator Session protocol (ADR 0030 / 0032).
 *
 * Pi JSONL and genuine AgentSession events are the sole conversation truth.
 * Wiki Runs start only through the real `wiki_produce` tool. The SSE seam has
 * no product inject, replay cursor, or sequence protocol.
 */

import { z } from "zod";
import { AgentMessageSchema } from "./agent-message.js";
import { AgentStreamViewPatchSchema } from "./agent-stream.js";
import { WikiProduceToolDetailsSchema } from "./wiki-produce.js";

/** Relative dir under workspace meta: `{root}/.okf-wiki/pi-sessions/`. */
export const PI_SESSIONS_DIR = "pi-sessions" as const;

// ---------------------------------------------------------------------------
// Agent commands (client → server → AgentSession)
// Plan/publication HITL is ResolveGate on WikiRuns, not a Session command.
// ---------------------------------------------------------------------------

export const AgentPromptCommandSchema = z.object({
  type: z.literal("prompt"),
  text: z.string().min(1).max(100_000),
});

export const AgentSteerCommandSchema = z.object({
  type: z.literal("steer"),
  text: z.string().min(1).max(100_000),
});

export const AgentAbortCommandSchema = z.object({
  type: z.literal("abort"),
});

export const AgentCompactCommandSchema = z.object({
  type: z.literal("compact"),
});

/**
 * Switch this Operator Session's chat model to a Settings model profile.
 * Session-scoped and non-durable: workspace.model stays the default for
 * new Sessions; role models for Wiki Runs are unaffected.
 */
export const AgentSetModelCommandSchema = z.object({
  type: z.literal("set_model"),
  profileId: z.string().min(1).max(200),
});

export const AgentCommandSchema = z.discriminatedUnion("type", [
  AgentPromptCommandSchema,
  AgentSteerCommandSchema,
  AgentAbortCommandSchema,
  AgentCompactCommandSchema,
  AgentSetModelCommandSchema,
]);

export type AgentPromptCommand = z.infer<typeof AgentPromptCommandSchema>;
export type AgentSteerCommand = z.infer<typeof AgentSteerCommandSchema>;
export type AgentAbortCommand = z.infer<typeof AgentAbortCommandSchema>;
export type AgentCompactCommand = z.infer<typeof AgentCompactCommandSchema>;
export type AgentSetModelCommand = z.infer<typeof AgentSetModelCommandSchema>;
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

/** Parse and validate an agent command body. Throws ZodError on failure. */
export function parseAgentCommand(input: unknown): AgentCommand {
  return AgentCommandSchema.parse(input);
}

/** Safe parse helper for HTTP adapters. */
export function safeParseAgentCommand(
  input: unknown,
): { success: true; data: AgentCommand } | { success: false; error: z.ZodError } {
  const result = AgentCommandSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

// ---------------------------------------------------------------------------
// Agent SSE (server → client)
// ---------------------------------------------------------------------------

/** Server keepalive on the AgentSession SSE stream. */
export const AgentSseHeartbeatSchema = z
  .object({
    source: z.literal("server"),
    kind: z.literal("heartbeat"),
    sessionId: z.string().min(1),
    timestamp: z.string().datetime(),
  })
  .strict();

export type AgentSseHeartbeat = z.infer<typeof AgentSseHeartbeatSchema>;

/** Current live Pi tool projection carried beside the durable SessionManager branch. */
export const AgentSseActiveToolSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1).max(100),
    details: WikiProduceToolDetailsSchema,
  })
  .strict();

export type AgentSseActiveTool = z.infer<typeof AgentSseActiveToolSchema>;

/** Current SessionManager branch plus genuine live tool state, sent first on SSE. */
export const AgentSseSnapshotSchema = z
  .object({
    source: z.literal("server"),
    kind: z.literal("snapshot"),
    sessionId: z.string().min(1),
    timestamp: z.string().datetime(),
    payload: z
      .object({
        session: z
          .object({
            id: z.string().min(1),
            workspaceId: z.string().min(1),
          })
          .strict(),
        /**
         * Durable SessionManager branch, already projected to AgentMessage[]
         * (ADR 0031: view = project(...); server owns the projection).
         */
        messages: z.array(AgentMessageSchema),
        /** Latest genuine Pi tool update; absent when no tool is live. */
        activeTool: AgentSseActiveToolSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type AgentSseSnapshot = z.infer<typeof AgentSseSnapshotSchema>;

/**
 * Live stream view patch (server-reduced Pi events → AgentMessage ops).
 * Web applies patches; it does not parse Pi content blocks on the live path.
 */
export const AgentSseStreamSchema = z
  .object({
    source: z.literal("server"),
    kind: z.literal("stream"),
    sessionId: z.string().min(1),
    timestamp: z.string().datetime(),
    payload: AgentStreamViewPatchSchema,
  })
  .strict();

export type AgentSseStream = z.infer<typeof AgentSseStreamSchema>;

/**
 * @deprecated Live path emits {@link AgentSseStreamSchema} instead. Kept only
 * for typing transitional fixtures; not part of AgentSseEventSchema.
 */
export const PiAgentSseEventSchema = z
  .object({
    source: z.literal("pi"),
    kind: z.string().min(1).max(64),
    sessionId: z.string().min(1),
    payload: z.unknown().optional(),
    timestamp: z.string().datetime().optional(),
  })
  .strict();

export type PiAgentSseEvent = z.infer<typeof PiAgentSseEventSchema>;

export const AgentSseEventSchema = z.union([
  AgentSseSnapshotSchema,
  AgentSseStreamSchema,
  AgentSseHeartbeatSchema,
]);

export type AgentSseEvent = z.infer<typeof AgentSseEventSchema>;

// ---------------------------------------------------------------------------
// Session list / create DTOs
// ---------------------------------------------------------------------------

/** Outbound session list row — typed for HTTP responses, never inbound-validated. */
export type PiSessionSummary = {
  id: string;
  title?: string;
  /** ISO mtime when known. */
  updatedAt?: string;
};

export const CreatePiAgentSessionBodySchema = z.object({
  /** Optional client-supplied id; server generates UUID when omitted. */
  sessionId: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(200).optional(),
});

export type CreatePiAgentSessionBody = z.infer<typeof CreatePiAgentSessionBodySchema>;

/** Outbound create-session response — typed only. */
export type CreatePiAgentSessionResponse = {
  session: {
    id: string;
    workspaceId: string;
    title: string;
    createdAt: string;
  };
};

/** Outbound command ack — typed only. */
export type AgentCommandResponse = {
  ok: boolean;
  sessionId: string;
  command: "prompt" | "steer" | "abort" | "compact" | "set_model";
  status: "accepted" | "failed";
  message?: string;
  runId?: string;
  /** Resolved model id after a successful set_model. */
  modelId?: string;
};
