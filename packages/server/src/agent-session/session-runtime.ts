/**
 * Long-lived runtime for one Pi-native Operator Session.
 *
 * Owns the live Pi handle, its ephemeral projection, command admission, and
 * disposal. The registry only retains these runtimes by session key.
 */

import {
  createOperatorSession,
  expandOperatorCommand,
  type OperatorSessionHistory,
  projectOperatorAgentMessages,
  projectOperatorHistoryFromManager,
  redactErrorMessage,
  redactSensitiveValue,
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
import {
  activeToolUpdate,
  initialLiveStreamState,
  projectLiveStreamEvent,
} from "../project-pi-sse.ts";
import { sessionUsageFromPiEvent, sessionUsageFromPiRows } from "./session-usage.ts";

type OperatorSessionHandle = Awaited<ReturnType<typeof createOperatorSession>>;

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
};

export type CompactOptions = {
  mode?: "idle" | "stop_and_compact";
};

export type LiveAgentSessionSummary = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

export type LiveSessionHistory = Pick<OperatorSessionHistory, "sessionId" | "messages"> & {
  sessionUsage?: SessionUsage;
};

/** HTTP-facing commands and SSE snapshots for one live Operator Session. */
export type SessionRuntime = {
  submit(message: string, delivery: Delivery): Promise<AgentCommandResponse>;
  cancel(scope: CancelScope): Promise<AgentCommandResponse>;
  compact(options?: CompactOptions): Promise<AgentCommandResponse>;
  setModel(profileId: string): Promise<AgentCommandResponse>;
  dispatch(command: AgentCommand): Promise<AgentCommandResponse>;
  snapshot(): SessionProjection;
  isBusy(): boolean;
};

/** Internal registry surface. No Pi handle escapes this module. */
export type LiveSessionRuntime = SessionRuntime & {
  readonly sessionId: string;
  readonly workspaceId: string;
  updateWorkspace(workspace: WorkspaceConfig): void;
  summary(): LiveAgentSessionSummary;
  history(): LiveSessionHistory;
  rawBranchMessages(): unknown[];
  appendDurableMessages(messages: ReadonlyArray<unknown>): void;
  receivePiEvent(event: unknown): void;
  activeTool(): AgentSseActiveTool | undefined;
  sessionUsage(): SessionUsage | undefined;
  touch(): void;
  isEvictable(now: number, idleTtlMs: number): boolean;
  beginClosing(): void;
  abortAndSettle(timeoutMs: number): Promise<void>;
  dispose(): void;
};

const SETTLE_POLL_MS = 25;

function makeTurnId(): string {
  return `turn_${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultTitle(workspace: WorkspaceConfig): string {
  return `Wiki Agent · ${workspace.name.trim() || "workspace"}`;
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closingFailure(
  sessionId: string,
  command: AgentCommandResponse["command"],
): AgentCommandResponse {
  return {
    ok: false,
    sessionId,
    command,
    status: "failed",
    message: "Operator Session is being deleted",
  };
}

/**
 * One runtime is created with a live Pi handle and retained until cache
 * eviction or deletion. Pi events and detached-prompt completion cannot mutate
 * or emit after beginClosing/dispose.
 */
export function createSessionRuntime(input: {
  workspace: WorkspaceConfig;
  handle: OperatorSessionHandle;
  queueFixtureTurn?: (text: string, canProduce: boolean) => void;
}): LiveSessionRuntime {
  const { workspace, handle, queueFixtureTurn } = input;
  const sessionId = handle.sessionId;
  let currentWorkspace = workspace;
  let admittedTurnId: string | undefined;
  let lastActivityAt = Date.now();
  let activeTool: AgentSseActiveTool | undefined;
  let streamState = initialLiveStreamState();
  let sessionUsage: SessionUsage | undefined;
  let closing = false;
  let disposed = false;
  let unsubscribe = (): void => undefined;

  const touch = (): void => {
    if (!disposed && !closing) lastActivityAt = Date.now();
  };

  const updateWorkspace = (next: WorkspaceConfig): void => {
    currentWorkspace = next;
  };

  const contextPhaseOf = (): ContextPhase => {
    const compacting =
      streamState.agentStatus === "compacting" || streamState.contextPhase === "compacting";
    try {
      if (handle.session.isCompacting) return "compacting";
    } catch {
      // Disposed handle — use the last stream/usage projection.
    }
    if (compacting) return "compacting";
    return deriveContextPhase({
      contextTokens: sessionUsage?.contextTokens,
      contextTarget: sessionUsage?.contextTarget,
      contextWindow: sessionUsage?.contextWindow,
    });
  };

  const isBusy = (): boolean => {
    if (closing || admittedTurnId) return true;
    try {
      return !handle.session.isIdle;
    } catch {
      // A broken Pi session is not safe for a new command.
      return true;
    }
  };

  const releaseAdmission = (turnId: string): void => {
    if (admittedTurnId === turnId) admittedTurnId = undefined;
  };

  const requestAbort = (): void => {
    try {
      // Pi's public abort waits for idle; HTTP commands only request cancellation.
      void handle.session.abort().catch(() => undefined);
    } catch {
      // A broken session is reported by its existing SSE/error path.
    }
  };

  const projectDetachedFailure = (error: unknown): void => {
    if (closing || disposed) return;
    const message = `prompt failed: ${redactErrorMessage(error)}`;
    try {
      const advanced = projectLiveStreamEvent(sessionId, streamState, { type: "error", message });
      streamState = advanced.state;
      emitAgentSessionEvent(currentWorkspace.id, sessionId, advanced.frame);
    } catch {
      // Projection itself must not crash the process.
    }
  };

  const receivePiEvent = (event: unknown): void => {
    if (closing || disposed) return;
    touch();
    const tool = activeToolUpdate(event);
    if (tool === null) activeTool = undefined;
    else if (tool) activeTool = tool;

    const advanced = projectLiveStreamEvent(sessionId, streamState, event);
    streamState = advanced.state;
    const usageUpdate = sessionUsageFromPiEvent(event, sessionUsage, {
      contextBudget: handle.contextBudget,
    });
    if (usageUpdate) {
      sessionUsage = usageUpdate;
      advanced.frame = {
        ...advanced.frame,
        payload: {
          ...advanced.frame.payload,
          sessionUsage: usageUpdate,
          contextPhase: advanced.state.contextPhase,
        },
      };
    } else if (advanced.frame.payload.contextPhase === undefined) {
      advanced.frame = {
        ...advanced.frame,
        payload: {
          ...advanced.frame.payload,
          contextPhase: advanced.state.contextPhase,
        },
      };
    }
    emitAgentSessionEvent(currentWorkspace.id, sessionId, advanced.frame);
  };

  unsubscribe = handle.session.subscribe(receivePiEvent);

  const submit = async (message: string, delivery: Delivery): Promise<AgentCommandResponse> => {
    const command = delivery === "prompt" ? "prompt" : delivery === "steer" ? "steer" : "follow_up";
    if (closing || disposed) return closingFailure(sessionId, command);
    touch();
    if (delivery === "prompt" && isBusy()) {
      return {
        ok: false,
        sessionId,
        command: "prompt",
        status: "failed",
        message: "Operator Session already has an active turn",
      };
    }
    if (delivery !== "prompt" && !isBusy()) {
      return {
        ok: false,
        sessionId,
        command,
        status: "failed",
        message: "Operator Session has no active turn for steer or follow-up",
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
      if (
        handle.session.sessionManager.getSessionName()?.trim() === defaultTitle(currentWorkspace)
      ) {
        const title = titleFromPrompt(message);
        if (title) handle.session.setSessionName(title);
      }
    }

    const acceptedTurnId = makeTurnId();
    if (delivery === "prompt") {
      admittedTurnId = acceptedTurnId;
      queueFixtureTurn?.(effectiveText, currentWorkspace.sources.length > 0);
      void handle.session
        .prompt(effectiveText)
        .catch(projectDetachedFailure)
        .finally(() => releaseAdmission(acceptedTurnId));
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
      if (delivery === "steer") await handle.session.steer(effectiveText);
      else await handle.session.followUp(effectiveText);
      return {
        ok: true,
        sessionId,
        command,
        status: "accepted",
        acceptedTurnId,
      };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command,
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  };

  const cancel = async (scope: CancelScope): Promise<AgentCommandResponse> => {
    const command =
      scope === "turn" ? "abort" : scope === "queued" ? "clear_queue" : "abort_compaction";
    if (closing || disposed) return closingFailure(sessionId, command);
    touch();
    if (scope === "turn") {
      requestAbort();
      releaseAdmission(admittedTurnId ?? "");
      return { ok: true, sessionId, command, status: "accepted" };
    }
    try {
      if (scope === "queued") handle.session.clearQueue();
      else handle.session.abortCompaction();
      return { ok: true, sessionId, command, status: "accepted" };
    } catch (error) {
      return {
        ok: false,
        sessionId,
        command,
        status: "failed",
        message: redactErrorMessage(error),
      };
    }
  };

  const compact = async (options?: CompactOptions): Promise<AgentCommandResponse> => {
    if (closing || disposed) return closingFailure(sessionId, "compact");
    touch();
    const mode = options?.mode ?? "idle";
    try {
      if (mode === "stop_and_compact") {
        await handle.session.abort().catch(() => undefined);
        releaseAdmission(admittedTurnId ?? "");
        if (closing || disposed) return closingFailure(sessionId, "compact");
      } else if (isBusy()) {
        return {
          ok: false,
          sessionId,
          command: "compact",
          status: "failed",
          message: "Operator Session has an active turn; use stop_and_compact or wait for idle",
        };
      }
      await handle.session.compact();
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
  };

  const setModel = async (profileId: string): Promise<AgentCommandResponse> => {
    if (closing || disposed) return closingFailure(sessionId, "set_model");
    touch();
    if (isBusy()) {
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
      if (closing || disposed) return closingFailure(sessionId, "set_model");
      await handle.session.setModel(resolved.model);
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
  };

  const dispatch = async (command: AgentCommand): Promise<AgentCommandResponse> => {
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
  };

  const snapshot = (): SessionProjection => {
    const contextPhase = contextPhaseOf();
    if (!closing && streamState.contextPhase !== contextPhase) {
      streamState = { ...streamState, contextPhase };
    }
    return {
      sessionId,
      streamState,
      ...(activeTool ? { activeTool } : {}),
      ...(sessionUsage ? { sessionUsage } : {}),
      contextPhase,
    };
  };

  const summary = (): LiveAgentSessionSummary => {
    const manager = handle.session.sessionManager;
    const header = manager.getHeader();
    if (!header) throw new Error("Pi did not initialize the Operator Session");
    return {
      id: manager.getSessionId(),
      title: manager.getSessionName()?.trim() || undefined,
      createdAt: header.timestamp,
      updatedAt: manager.getBranch().at(-1)?.timestamp ?? header.timestamp,
    };
  };

  const history = (): LiveSessionHistory => {
    touch();
    const piRows = projectOperatorHistoryFromManager(handle.session.sessionManager);
    const redactedRows = redactSensitiveValue(piRows) as readonly unknown[];
    const messages = projectOperatorAgentMessages(redactedRows);
    const usage =
      sessionUsage ??
      sessionUsageFromPiRows(redactedRows, {
        contextBudget: handle.contextBudget,
      });
    if (usage && !closing && !disposed) sessionUsage = usage;
    return {
      sessionId: handle.session.sessionManager.getSessionId(),
      messages,
      ...(usage ? { sessionUsage: usage } : {}),
    };
  };

  const rawBranchMessages = (): unknown[] => {
    const messages: unknown[] = [];
    for (const row of handle.session.sessionManager.getBranch()) {
      if (row.type === "message") messages.push(row.message);
    }
    return messages;
  };

  const appendDurableMessages = (messages: ReadonlyArray<unknown>): void => {
    if (closing || disposed) throw new Error(`Operator Session is being deleted: ${sessionId}`);
    for (const message of messages) {
      handle.session.sessionManager.appendMessage(message as never);
    }
    touch();
  };

  const isEvictable = (now: number, idleTtlMs: number): boolean => {
    if (closing || disposed || admittedTurnId) return false;
    try {
      if (!handle.session.isIdle) return false;
    } catch {
      // Broken handles are cache-evictable.
    }
    return now - lastActivityAt >= idleTtlMs;
  };

  const beginClosing = (): void => {
    closing = true;
  };

  const abortAndSettle = async (timeoutMs: number): Promise<void> => {
    beginClosing();
    requestAbort();
    const isQuiet = (): boolean => {
      try {
        if (!handle.session.isIdle) return false;
      } catch {
        return true;
      }
      return !admittedTurnId;
    };
    if (isQuiet()) return;
    let keepWaiting = true;
    const waitAdmissionClear = async (): Promise<void> => {
      while (keepWaiting && admittedTurnId) await sleep(SETTLE_POLL_MS);
    };
    try {
      await Promise.race([
        Promise.all([handle.session.waitForIdle().catch(() => undefined), waitAdmissionClear()]),
        sleep(timeoutMs),
      ]);
    } finally {
      keepWaiting = false;
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    closing = true;
    try {
      unsubscribe();
    } catch {
      // Already detached.
    }
    try {
      handle.dispose();
    } catch {
      // Already disposed.
    }
  };

  return {
    sessionId,
    workspaceId: workspace.id,
    updateWorkspace,
    submit,
    cancel,
    compact,
    setModel,
    dispatch,
    snapshot,
    isBusy,
    summary,
    history,
    rawBranchMessages,
    appendDurableMessages,
    receivePiEvent,
    activeTool: () => activeTool,
    sessionUsage: () => sessionUsage,
    touch,
    isEvictable,
    beginClosing,
    abortAndSettle,
    dispose,
  };
}
