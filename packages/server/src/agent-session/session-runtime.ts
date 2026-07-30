/**
 * SessionRuntime — deep module over Pi Operator Session lifecycle.
 *
 * Hides preflight, detached prompt admission, cancel scopes, compaction, and
 * projection snapshot behind a small interface. Routes only ACK admission;
 * turn terminal state is agent_settled via Session SSE (not HTTP).
 */

import {
  expandOperatorCommand,
  redactErrorMessage,
  resolveWorkspacePiModel,
} from "@okf-wiki/agent";
import type {
  AgentCommand,
  AgentCommandResponse,
  AgentSseActiveTool,
  ContextPhase,
  PiStreamState,
  SessionUsage,
  WorkspaceConfig,
} from "@okf-wiki/contract";
import { deriveContextPhase } from "@okf-wiki/contract";
import { emitAgentSessionEvent } from "../agent-session-events.ts";
import { projectLiveStreamEvent } from "../project-pi-sse.ts";
import type { RegisteredAgentSession } from "./live-session-registry.ts";
import { defaultTitle } from "./session-lifecycle.ts";

function makeTurnId(): string {
  return `turn_${Math.random().toString(36).slice(2, 10)}`;
}

export type Delivery = "prompt" | "steer" | "follow_up";
export type CancelScope = "turn" | "queued" | "compaction";

export type AcceptedTurn = {
  acceptedTurnId: string;
  sessionId: string;
  delivery: Delivery;
};

export type SessionProjection = {
  sessionId: string;
  streamState: PiStreamState;
  activeTool?: AgentSseActiveTool;
  sessionUsage?: SessionUsage;
  contextPhase: ContextPhase;
  /** True while an admitted turn is in flight or Pi reports non-idle. */
  busy: boolean;
};

export type SessionProjectionEvent = {
  kind: "stream" | "snapshot_hint";
  projection: SessionProjection;
};

export type CompactOptions = {
  mode?: "idle" | "stop_and_compact";
};

export type SessionRuntime = {
  submit(message: string, delivery: Delivery): Promise<AgentCommandResponse>;
  cancel(scope: CancelScope): Promise<AgentCommandResponse>;
  compact(options?: CompactOptions): Promise<AgentCommandResponse>;
  setModel(profileId: string): Promise<AgentCommandResponse>;
  dispatch(command: AgentCommand): Promise<AgentCommandResponse>;
  snapshot(): SessionProjection;
  /** Whether an admitted turn or non-idle Pi session blocks new prompts. */
  isBusy(): boolean;
};

function titleFromPrompt(text: string, max = 60): string | undefined {
  const firstLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function contextPhaseOf(entry: RegisteredAgentSession): ContextPhase {
  const compacting =
    entry.streamState.agentStatus === "compacting" ||
    entry.streamState.contextPhase === "compacting";
  try {
    if (entry.handle.session.isCompacting) {
      return "compacting";
    }
  } catch {
    // Disposed handle — fall through to stream/usage.
  }
  if (compacting) return "compacting";
  return deriveContextPhase({
    contextTokens: entry.sessionUsage?.contextTokens,
    contextTarget: entry.sessionUsage?.contextTarget,
    contextWindow: entry.sessionUsage?.contextWindow,
  });
}

function isEntryBusy(entry: RegisteredAgentSession): boolean {
  if (entry.admittedTurnId) return true;
  try {
    if (!entry.handle.session.isIdle) return true;
  } catch {
    // Treat broken handles as not busy for admission (will fail later).
  }
  return entry.streamState.turnActive;
}

/**
 * Project a synthetic stream error when a detached turn fails without Pi events.
 * Never throws — unhandled rejections must not escape SessionRuntime.
 */
function projectDetachedFailure(
  entry: RegisteredAgentSession,
  error: unknown,
): void {
  const message = `prompt failed: ${redactErrorMessage(error)}`;
  try {
    const advanced = projectLiveStreamEvent(entry.handle.sessionId, entry.streamState, {
      type: "error",
      message,
    });
    entry.streamState = advanced.state;
    emitAgentSessionEvent(entry.workspaceId, entry.handle.sessionId, advanced.frame);
  } catch {
    // Projection itself must not crash the process.
  }
}

function releaseAdmission(entry: RegisteredAgentSession, turnId: string): void {
  if (entry.admittedTurnId === turnId) {
    entry.admittedTurnId = undefined;
  }
}

export function snapshotSession(entry: RegisteredAgentSession): SessionProjection {
  const contextPhase = contextPhaseOf(entry);
  // Keep stream state phase aligned for clients that only read patches.
  if (entry.streamState.contextPhase !== contextPhase) {
    entry.streamState = { ...entry.streamState, contextPhase };
  }
  return {
    sessionId: entry.handle.sessionId,
    streamState: entry.streamState,
    ...(entry.activeTool ? { activeTool: entry.activeTool } : {}),
    ...(entry.sessionUsage ? { sessionUsage: entry.sessionUsage } : {}),
    contextPhase,
    busy: isEntryBusy(entry),
  };
}

/**
 * Bind a SessionRuntime to one live registry entry + workspace.
 * Deep module: callers only use submit/cancel/compact/snapshot.
 */
export function createSessionRuntime(
  entry: RegisteredAgentSession,
  workspace: WorkspaceConfig,
): SessionRuntime {
  const sessionId = entry.handle.sessionId;

  async function submit(message: string, delivery: Delivery): Promise<AgentCommandResponse> {
    if (delivery === "prompt" && isEntryBusy(entry)) {
      return {
        ok: false,
        sessionId,
        command: "prompt",
        status: "failed",
        message: "Operator Session already has an active turn",
      };
    }

    let effectiveText = message;
    if (delivery === "prompt") {
      const expansion = expandOperatorCommand(message);
      if (expansion.kind === "unknown") {
        return {
          ok: false,
          sessionId,
          command: "prompt",
          status: "failed",
          message: `unknown command: /${expansion.command}`,
        };
      }
      effectiveText = expansion.kind === "expanded" ? expansion.prompt : message;
    }

    if (
      delivery === "prompt" &&
      entry.handle.session.sessionManager.getSessionName()?.trim() === defaultTitle(workspace)
    ) {
      const title = titleFromPrompt(message);
      if (title) entry.handle.session.setSessionName(title);
    }

    const acceptedTurnId = makeTurnId();
    const commandName =
      delivery === "prompt" ? "prompt" : delivery === "steer" ? "steer" : "follow_up";

    if (delivery === "prompt") {
      // Admission lock — cleared when the detached prompt settles (after agent_settled).
      entry.admittedTurnId = acceptedTurnId;
      entry.queueFixtureTurn?.(effectiveText, workspace.sources.length > 0);

      // Detached turn: HTTP returns after admission; errors project via Session SSE.
      void entry.handle.session
        .prompt(effectiveText)
        .catch((error: unknown) => {
          projectDetachedFailure(entry, error);
        })
        .finally(() => {
          releaseAdmission(entry, acceptedTurnId);
        });

      return {
        ok: true,
        sessionId,
        command: "prompt",
        status: "accepted",
        message: "prompt admitted",
        acceptedTurnId,
      };
    }

    try {
      if (delivery === "steer") {
        await entry.handle.session.steer(effectiveText);
      } else {
        await entry.handle.session.followUp(effectiveText);
      }
      return {
        ok: true,
        sessionId,
        command: commandName,
        status: "accepted",
        acceptedTurnId,
      };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: commandName,
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }

  async function cancel(scope: CancelScope): Promise<AgentCommandResponse> {
    if (scope === "turn") {
      await entry.handle.session.abort().catch(() => undefined);
      // Admission may outlive abort until prompt promise settles; clear optimistically
      // so a new prompt can be admitted after stop.
      entry.admittedTurnId = undefined;
      return { ok: true, sessionId, command: "abort", status: "accepted" };
    }
    if (scope === "queued") {
      try {
        entry.handle.session.clearQueue();
        return { ok: true, sessionId, command: "clear_queue", status: "accepted" };
      } catch (error) {
        return {
          ok: false,
          sessionId,
          command: "clear_queue",
          status: "failed",
          message: redactErrorMessage(error),
        };
      }
    }
    try {
      entry.handle.session.abortCompaction();
      return { ok: true, sessionId, command: "abort_compaction", status: "accepted" };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: "abort_compaction",
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }

  async function compact(options?: CompactOptions): Promise<AgentCommandResponse> {
    const mode = options?.mode ?? "idle";
    try {
      if (mode === "stop_and_compact") {
        await entry.handle.session.abort().catch(() => undefined);
        entry.admittedTurnId = undefined;
      } else if (isEntryBusy(entry)) {
        return {
          ok: false,
          sessionId,
          command: "compact",
          status: "failed",
          message: "Operator Session has an active turn; use stop_and_compact or wait for idle",
        };
      }
      await entry.handle.session.compact();
      return { ok: true, sessionId, command: "compact", status: "accepted" };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: "compact",
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }

  async function setModel(profileId: string): Promise<AgentCommandResponse> {
    if (isEntryBusy(entry)) {
      return {
        ok: false,
        sessionId,
        command: "set_model",
        status: "failed",
        message: "Operator Session has an active turn; retry after it completes",
      };
    }
    try {
      const resolved = await resolveWorkspacePiModel({ profileId });
      await entry.handle.session.setModel(resolved.model);
      return {
        ok: true,
        sessionId,
        command: "set_model",
        status: "accepted",
        modelId: resolved.model.id,
      };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command: "set_model",
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  }

  async function dispatch(command: AgentCommand): Promise<AgentCommandResponse> {
    switch (command.type) {
      case "prompt":
        return submit(command.text, "prompt");
      case "steer":
        return submit(command.text, "steer");
      case "follow_up":
        return submit(command.text, "follow_up");
      case "abort":
        return cancel("turn");
      case "clear_queue":
        return cancel("queued");
      case "abort_compaction":
        return cancel("compaction");
      case "compact":
        return compact({ mode: command.mode });
      case "set_model":
        return setModel(command.profileId);
      default: {
        const _exhaustive: never = command;
        void _exhaustive;
        return {
          ok: false,
          sessionId,
          command: "prompt",
          status: "failed",
          message: "unknown command",
        };
      }
    }
  }

  return {
    submit,
    cancel,
    compact,
    setModel,
    dispatch,
    snapshot: () => snapshotSession(entry),
    isBusy: () => isEntryBusy(entry),
  };
}
