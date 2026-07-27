/** React adapter for the Pi-only Operator Session stream (ADR 0032). */

import type {
  AgentCommand,
  AgentCommandResponse,
  AgentResumeGateCommand,
} from "@okf-wiki/contract";
import { AgentSseEventSchema } from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentSessionCommand, agentSessionEventsUrl } from "../../api";
import { makeId } from "./project/format";
import { createPiStreamState, projectAgentEvent, viewMessages } from "./project/pi";
import type { AgentMessage, AgentSseLike, AgentToolCall, PiStreamState } from "./project/types";

/** Unified command failure check (server uses ok/status, not string heuristics). */
export function isCommandFailed(res: AgentCommandResponse | null | undefined): boolean {
  if (!res) return false;
  return res.ok === false || res.status === "failed";
}

export type { AgentMessage, AgentToolCall };

export type AgentMessageRole = AgentMessage["role"];
/** UI status: stream-projected idle/streaming/error plus hook-only optimistic `sending`. */
export type AgentStatus = "idle" | "sending" | "streaming" | "error";

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
  resumeGate: (command: AgentResumeGateCommand) => Promise<void>;
  /** Switch this Session's chat model to a Settings profile; true on success. */
  setModel: (profileId: string) => Promise<boolean>;
  clearError: () => void;
  eventsUrl: string | null;
  lastCommandResponse: AgentCommandResponse | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function useSessionAgent({
  workspaceId,
  sessionId,
  rootPath,
}: UseSessionAgentArgs): UseSessionAgentResult {
  // setStatus updates are announced via Composer role=status.
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | null>(null);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [ready, setReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [lastCommandResponse, setLastCommandResponse] = useState<AgentCommandResponse | null>(null);

  const streamStateRef = useRef<PiStreamState>(createPiStreamState());
  const eventSourceRef = useRef<EventSource | null>(null);
  const sendInFlightRef = useRef(false);
  const readyRef = useRef(false);

  const eventsUrl = useMemo(
    () => (sessionId ? agentSessionEventsUrl(workspaceId, sessionId, rootPath) : null),
    [workspaceId, sessionId, rootPath],
  );

  const publish = useCallback((state: PiStreamState) => {
    streamStateRef.current = state;
    setMessages(viewMessages(state));
    setStreamingMessage(state.streamingMessage);
  }, []);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    streamStateRef.current = createPiStreamState();
    setMessages([]);
    setStreamingMessage(null);
    setStatus("idle");
    setReady(false);
    readyRef.current = false;
    setError(null);
    setLastCommandResponse(null);
    sendInFlightRef.current = false;

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

      // Status/error come from the Pi projector. Optimistic `sending` is
      // hook-only — keep it until the stream confirms (streaming/error) or
      // send() settles the command without a live turn.
      if (event.source === "pi" || (event.source === "server" && event.kind === "snapshot")) {
        setStatus((current) => {
          if (current === "sending" && next.agentStatus === "idle") return "sending";
          return next.agentStatus;
        });
        setError(next.errorText);
      }
    };

    // Native EventSource reconnects. Each reconnect receives a fresh snapshot,
    // which replaces local state; no client replay cursor or ring is needed.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setReady(false);
        readyRef.current = false;
        setConnectionStatus("offline");
        setStatus((current) => (current === "error" ? current : "idle"));
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
      if (!sessionId || !value || sendInFlightRef.current) return;

      sendInFlightRef.current = true;
      setInput("");
      setError(null);
      setStatus("sending");

      // Client-only optimistic row. Snapshot projection is authority — optimistic
      // rows do not survive a server snapshot. Live Pi user events are ignored.
      // Clear projector stream error so a later event cannot re-apply it.
      const optimistic: AgentMessage = {
        id: makeId("user"),
        role: "user",
        content: value,
        createdAt: nowIso(),
        status: "done",
        optimistic: true,
      };
      const next = {
        ...streamStateRef.current,
        messages: [...streamStateRef.current.messages, optimistic],
        errorText: null,
      };
      publish(next);

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
          setError(response?.message ?? "Agent command failed");
          setStatus("error");
        } else if (!streamStateRef.current.turnActive) {
          setStatus("idle");
        }
      } catch (caught) {
        rollbackOptimistic();
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus("error");
      } finally {
        sendInFlightRef.current = false;
      }
    },
    [input, sessionId, publish, runCommand],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    try {
      const response = await runCommand({ type: "abort" });
      if (isCommandFailed(response)) {
        setError(response?.message ?? "Abort failed");
        setStatus("error");
        return;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("error");
      return;
    }
    // Projector-only surface: do not synthesize local state here. Pi's own
    // message_end(aborted) / agent_end events finalize the partial stream
    // (neutral aborted marker) and settle status back to idle.
  }, [sessionId, runCommand]);

  const setModel = useCallback(
    async (profileId: string): Promise<boolean> => {
      setError(null);
      try {
        const response = await runCommand({ type: "set_model", profileId });
        if (isCommandFailed(response)) {
          setError(response?.message ?? "Model switch failed");
          return false;
        }
        return true;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return false;
      }
    },
    [runCommand],
  );

  const resumeGate = useCallback(
    async (command: AgentResumeGateCommand) => {
      setError(null);
      try {
        const response = await runCommand(command);
        if (isCommandFailed(response)) {
          throw new Error(response?.message ?? "Gate decision failed");
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setStatus("error");
        throw caught;
      }
    },
    [runCommand],
  );

  return {
    messages,
    streamingMessage,
    status,
    ready,
    connectionStatus,
    error,
    input,
    setInput,
    send,
    abort,
    resumeGate,
    setModel,
    clearError: () => {
      setError(null);
      const current = streamStateRef.current;
      if (current.errorText != null) {
        streamStateRef.current = { ...current, errorText: null };
      }
    },
    eventsUrl,
    lastCommandResponse,
  };
}
