/** React adapter for the Pi-only Operator Session stream (ADR 0032). */

import type { AgentCommand, AgentCommandResponse } from "@okf-wiki/contract";
import { AgentSseEventSchema } from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentSessionCommand, agentSessionEventsUrl } from "../../api";
import { type AgentStatus, clearErrorFromState, deriveAgentStatus } from "./derive-agent-status";
import { makeId } from "./project/format";
import { createPiStreamState, projectAgentEvent, viewMessages } from "./project/pi";
import type { AgentMessage, AgentSseLike, AgentToolCall, PiStreamState } from "./project/types";

/** Unified command failure check (server uses ok/status, not string heuristics). */
export function isCommandFailed(res: AgentCommandResponse | null | undefined): boolean {
  if (!res) return false;
  return res.ok === false || res.status === "failed";
}

export type { AgentMessage, AgentStatus, AgentToolCall };

export type AgentMessageRole = AgentMessage["role"];

/** SSE lifecycle for the session event stream. */
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "offline";

export type UseSessionAgentArgs = {
  workspaceId: string;
  sessionId: string | null;
  rootPath?: string;
};

export type UseSessionAgentResult = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  status: AgentStatus;
  ready: boolean;
  /** EventSource connection lifecycle (independent of agent turn status). */
  connectionStatus: ConnectionStatus;
  error: string | null;
  input: string;
  setInput: (value: string) => void;
  send: (text?: string) => Promise<void>;
  abort: () => Promise<void>;
  /** Switch this Session's chat model to a Settings profile; true on success. */
  setModel: (profileId: string) => Promise<boolean>;
  clearError: () => void;
  eventsUrl: string | null;
  lastCommandResponse: AgentCommandResponse | null;
};

/** Render view derived from stream state + hook-only optimistic sending. */
type SessionAgentView = {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | null;
  status: AgentStatus;
  error: string | null;
};

function viewFromStream(state: PiStreamState, sending: boolean): SessionAgentView {
  return {
    messages: viewMessages(state),
    streamingMessage: state.streamingMessage,
    status: deriveAgentStatus(state.agentStatus, sending),
    error: state.errorText,
  };
}

function withLocalError(state: PiStreamState, errorText: string): PiStreamState {
  return {
    ...state,
    agentStatus: "error",
    errorText,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

export function useSessionAgent({
  workspaceId,
  sessionId,
  rootPath,
}: UseSessionAgentArgs): UseSessionAgentResult {
  const [view, setView] = useState<SessionAgentView>(() =>
    viewFromStream(createPiStreamState(), false),
  );
  const [ready, setReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");
  const [input, setInput] = useState("");
  const [lastCommandResponse, setLastCommandResponse] = useState<AgentCommandResponse | null>(null);

  // True sources: stream projection (+ local clearError / command-error reducers)
  // and optimistic sending. Never put `sending` into contract PiStreamState.
  const streamStateRef = useRef<PiStreamState>(createPiStreamState());
  const sendingRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const readyRef = useRef(false);

  const eventsUrl = useMemo(
    () => (sessionId ? agentSessionEventsUrl(workspaceId, sessionId, rootPath) : null),
    [workspaceId, sessionId, rootPath],
  );

  /** Publish stream state → ref + derived React view (messages/status/error). */
  const publish = useCallback((state: PiStreamState) => {
    streamStateRef.current = state;
    setView(viewFromStream(state, sendingRef.current));
  }, []);

  /** Refresh view after toggling sending without a stream change. */
  const publishSending = useCallback((sending: boolean) => {
    sendingRef.current = sending;
    setView(viewFromStream(streamStateRef.current, sending));
  }, []);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    streamStateRef.current = createPiStreamState();
    sendingRef.current = false;
    setView(viewFromStream(createPiStreamState(), false));
    setReady(false);
    readyRef.current = false;
    setLastCommandResponse(null);

    if (!eventsUrl || typeof EventSource === "undefined") {
      setConnectionStatus("offline");
      return;
    }

    // sessionId set, stream opening — waiting for first snapshot
    setConnectionStatus("connecting");

    const source = new EventSource(eventsUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      // OPEN but not ready until snapshot arrives (or after reconnect until next snapshot)
      if (readyRef.current) {
        setConnectionStatus("live");
      } else {
        setConnectionStatus("connecting");
      }
    };

    source.onmessage = (message) => {
      let event: AgentSseLike;
      try {
        const parsed = AgentSseEventSchema.safeParse(JSON.parse(message.data));
        if (!parsed.success) return;
        event = parsed.data;
      } catch {
        return;
      }

      const next = projectAgentEvent(streamStateRef.current, event);
      publish(next);

      if (event.source === "server" && event.kind === "snapshot") {
        setReady(true);
        readyRef.current = true;
        setConnectionStatus("live");
      }
      // status/error for render come solely from publish → viewFromStream.
      // Optimistic sending is held in sendingRef until the command settles.
    };

    // Native EventSource reconnects. Each reconnect receives a fresh snapshot,
    // which replaces local state; no client replay cursor or ring is needed.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setReady(false);
        readyRef.current = false;
        setConnectionStatus("offline");
        // Preserve projected error; otherwise settle display status to idle.
        // (Does not rewrite connectionStatus/ready model — only agent view.)
        const current = streamStateRef.current;
        if (current.agentStatus !== "error") {
          publish({ ...current, agentStatus: "idle" });
        }
        return;
      }
      // CONNECTING (or transient error): browser is reconnecting
      setConnectionStatus("reconnecting");
    };

    return () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [eventsUrl, publish]);

  const runCommand = useCallback(
    async (command: AgentCommand): Promise<AgentCommandResponse | null> => {
      if (!sessionId) return null;
      const response = await agentSessionCommand(workspaceId, sessionId, command, rootPath);
      setLastCommandResponse(response);
      return response;
    },
    [workspaceId, sessionId, rootPath],
  );

  const send = useCallback(
    async (text?: string) => {
      const value = (text ?? input).trim();
      if (!sessionId || !value || sendingRef.current) return;

      publishSending(true);
      setInput("");

      // Client-only optimistic row. Snapshot projection is authority — optimistic
      // rows do not survive a server snapshot. Live Pi user events are ignored.
      // Clear projector stream error so a later event cannot re-apply it, and
      // drop projected error status so deriveAgentStatus can show "sending".
      const optimistic: AgentMessage = {
        id: makeId("user"),
        role: "user",
        content: value,
        createdAt: nowIso(),
        status: "done",
        optimistic: true,
      };
      const base = clearErrorFromState(streamStateRef.current);
      publish({
        ...base,
        messages: [...base.messages, optimistic],
        agentStatus: base.agentStatus === "error" ? "idle" : base.agentStatus,
      });

      // Command failure produces no server snapshot — roll the optimistic row
      // back explicitly so a rejected message never looks sent.
      const rollbackOptimistic = () => {
        const current = streamStateRef.current;
        publish({
          ...current,
          messages: current.messages.filter((m) => m.id !== optimistic.id),
        });
      };

      try {
        const response = await runCommand({ type: "prompt", text: value });
        if (isCommandFailed(response)) {
          rollbackOptimistic();
          publish(
            withLocalError(streamStateRef.current, response?.message ?? "Agent command failed"),
          );
        }
        // Successful prompt: leave stream projection as authority. Clearing
        // sending in finally re-derives idle vs streaming from turn state.
      } catch (caught) {
        rollbackOptimistic();
        publish(
          withLocalError(
            streamStateRef.current,
            caught instanceof Error ? caught.message : String(caught),
          ),
        );
      } finally {
        publishSending(false);
      }
    },
    [input, sessionId, publish, publishSending, runCommand],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await runCommand({ type: "abort" });
      if (isCommandFailed(response)) {
        publish(withLocalError(streamStateRef.current, response?.message ?? "Abort failed"));
        return;
      }
    } catch (caught) {
      publish(
        withLocalError(
          streamStateRef.current,
          caught instanceof Error ? caught.message : String(caught),
        ),
      );
      return;
    }
    // Projector-only surface: do not synthesize local state here. Pi's own
    // message_end(aborted) / agent_end events finalize the partial stream
    // (neutral aborted marker) and settle status back to idle.
  }, [sessionId, runCommand, publish]);

  const setModel = useCallback(
    async (profileId: string): Promise<boolean> => {
      publish(clearErrorFromState(streamStateRef.current));
      try {
        const response = await runCommand({ type: "set_model", profileId });
        if (isCommandFailed(response)) {
          // Banner only — keep agentStatus so Composer does not flip to error.
          publish({
            ...streamStateRef.current,
            errorText: response?.message ?? "Model switch failed",
          });
          return false;
        }
        return true;
      } catch (caught) {
        publish({
          ...streamStateRef.current,
          errorText: caught instanceof Error ? caught.message : String(caught),
        });
        return false;
      }
    },
    [runCommand, publish],
  );

  const clearError = useCallback(() => {
    publish(clearErrorFromState(streamStateRef.current));
  }, [publish]);

  return {
    messages: view.messages,
    streamingMessage: view.streamingMessage,
    status: view.status,
    ready,
    connectionStatus,
    error: view.error,
    input,
    setInput,
    send,
    abort,
    setModel,
    clearError,
    eventsUrl,
    lastCommandResponse,
  };
}
