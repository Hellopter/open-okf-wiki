/** View types projected directly from one Pi Operator Session. */

import type {
  AgentContentPart,
  AgentMessage as ContractAgentMessage,
  AgentMessageRole,
  AgentSseEvent,
  AgentToolCall,
  PiAgentStatus,
  PiStreamState as ContractPiStreamState,
} from "@okf-wiki/contract";

export type { AgentContentPart, AgentMessageRole, AgentToolCall, PiAgentStatus };

/**
 * Operator message view: contract wire shape plus optional client-only
 * optimistic marker (Composer send). Optimistic is never on the SSE wire.
 */
export type AgentMessage = ContractAgentMessage & {
  /**
   * Client-only optimistic user row (Composer send).
   * Snapshot projection is authority: optimistic rows do not survive a server
   * snapshot. Live stream patches merge without wiping unmatched local rows.
   */
  optimistic?: true;
};

/** Shared transport interface (snapshot | stream | heartbeat). */
export type AgentSseLike = AgentSseEvent;

/** Finalized durable rows plus at most one live Pi assistant snapshot. */
export type PiStreamState = ContractPiStreamState;
