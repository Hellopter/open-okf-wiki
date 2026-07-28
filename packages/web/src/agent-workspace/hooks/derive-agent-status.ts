/**
 * Pure UI status derivation for the Operator Session agent surface.
 *
 * Stream projection owns idle/streaming/error. Optimistic `sending` is
 * hook-only (never part of contract PiStreamState).
 */

import type { PiAgentStatus, PiStreamState } from "./project/types";

/** UI status: stream-projected idle/streaming/error plus hook-only optimistic `sending`. */
export type AgentStatus = "idle" | "sending" | "streaming" | "error";

/**
 * Derive Composer/shell agent status from projected stream status + optimistic send.
 *
 * Priority:
 * 1. Projected `error` always wins (command failures and stream errors).
 * 2. Projected `streaming` wins over optimistic sending (server confirmed the turn).
 * 3. Optimistic `sending` wins over projected `idle` (awaiting first stream event).
 * 4. Otherwise use projected status (`idle`).
 */
export function deriveAgentStatus(projected: PiAgentStatus, sending: boolean): AgentStatus {
  if (projected === "error") return "error";
  if (projected === "streaming") return "streaming";
  if (sending) return "sending";
  return projected;
}

/** Clear stream-level error text without inventing other local UI state. */
export function clearErrorFromState(state: PiStreamState): PiStreamState {
  return {
    ...state,
    errorText: null,
    agentStatus: state.agentStatus === "error" ? "idle" : state.agentStatus,
  };
}
