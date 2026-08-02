import {
  type AgentSseEvent,
  applyStreamPatch,
  createPiStreamState,
  type PiStreamState,
} from "@okf-wiki/contract";

/** Keep durable session history separate from the latest live stream patch. */
export function reduceSessionStreamEvent(
  state: PiStreamState,
  event: AgentSseEvent,
): PiStreamState {
  if (event.kind === "snapshot") {
    const snapshot = createPiStreamState(event.payload.messages);
    return {
      ...snapshot,
      contextPhase: event.payload.contextPhase ?? snapshot.contextPhase,
    };
  }
  if (event.kind === "stream") return applyStreamPatch(state, event.payload);
  return state;
}
