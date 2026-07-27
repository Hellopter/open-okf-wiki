/** View types projected directly from one Pi Operator Session. */

import type {
  AgentContentPart,
  AgentMessage as ContractAgentMessage,
  AgentMessageRole,
  AgentSseEvent,
  AgentToolCall,
} from "@okf-wiki/contract";

export type { AgentContentPart, AgentMessageRole, AgentToolCall };

/**
 * Operator message view: contract wire shape plus optional client-only
 * optimistic marker (Composer send). Optimistic is never on the SSE wire.
 */
export type AgentMessage = ContractAgentMessage & {
  /**
   * Client-only optimistic user row (Composer send).
   * Snapshot projection is authority: optimistic rows do not survive a server
   * snapshot. Live Pi `user` message events are ignored (prefer snapshot).
   */
  optimistic?: true;
};

/** Shared transport interface. Pi still owns event payload internals. */
export type AgentSseLike = AgentSseEvent;

/**
 * Turn status projected from the Pi stream (AgentStatus minus hook-only
 * optimistic `"sending"`).
 */
export type PiAgentStatus = "idle" | "streaming" | "error";

/** Finalized durable rows plus at most one live Pi assistant snapshot. */
export type PiStreamState = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  lastAssistantId: string | null;
  turnActive: boolean;
  /** Derived turn status for the Session Agent UI (no hook re-derivation). */
  agentStatus: PiAgentStatus;
  /** Provider/stream error text; null when no stream failure is active. */
  errorText: string | null;
};
