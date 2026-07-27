/**
 * Operator Session projector (ADR 0031 / 0032).
 *
 * Server owns Pi → stream reduce. Web applies snapshots + stream patches only.
 * Live Pi content blocks are never parsed on this path.
 */

import {
  AgentMessageSchema,
  applyStreamPatch,
  createPiStreamState,
  projectAgentMessagesFromPiHistory,
  toolOutputFromResult,
  updateToolInState,
  type PiStreamState,
} from "@okf-wiki/contract";
import type { AgentMessage, AgentSseLike } from "./types.ts";

export {
  createPiStreamState,
  reducePiEvent,
  updateToolInState,
  viewMessages,
} from "@okf-wiki/contract";
export type { PiStreamState } from "@okf-wiki/contract";

/**
 * Snapshot messages are AgentMessage[] from the server (ADR 0031).
 * Invalid rows are dropped rather than re-projected from Pi shapes.
 */
function snapshotMessages(rows: readonly unknown[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const row of rows) {
    const parsed = AgentMessageSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Project opaque Pi history rows into AgentMessage[] (tests / offline fixtures).
 * Live SSE snapshots already carry AgentMessage[] from the server.
 */
export function projectPiHistory(rows: readonly unknown[]): AgentMessage[] {
  return projectAgentMessagesFromPiHistory(rows);
}

/**
 * Fold accepted transport shapes: snapshot, live stream patch, heartbeat.
 *
 * Server snapshots fully replace local state — client-only optimistic user
 * rows never survive projection. Stream patches merge onto local state so
 * optimistic rows can remain until the next snapshot.
 */
export function projectAgentEvent(state: PiStreamState, event: AgentSseLike): PiStreamState {
  if (event.source === "server" && event.kind === "snapshot") {
    const rows = Array.isArray(event.payload.messages) ? event.payload.messages : [];
    const snapshot = createPiStreamState(snapshotMessages(rows));
    const activeTool = event.payload.activeTool;
    if (!activeTool) return snapshot;
    return {
      ...updateToolInState(snapshot, activeTool.toolCallId, {
        name: activeTool.toolName,
        details: activeTool.details,
        output: toolOutputFromResult(undefined, activeTool.details),
        status: "running",
      }),
      turnActive: true,
      agentStatus: "streaming",
    };
  }
  if (event.source === "server" && event.kind === "stream") {
    return applyStreamPatch(state, event.payload);
  }
  return state;
}
