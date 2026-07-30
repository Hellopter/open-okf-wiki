/** React adapter for the Pi-only Operator Session stream (ADR 0032). */

import type { AgentCommand, AgentCommandResponse, SessionUsage } from "@okf-wiki/contract";
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
  /**
   * Ephemeral context-fill from SSE snapshot / stream (last assistant
   * totalTokens + window). UI-only; not durable control truth.
   */
  sessionUsage: SessionUsage | null;
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

/** True when projected stream still owns an in-flight turn (including between ops). */
function streamTurnActive(state: PiStreamState): boolean {
  if (state.turnActive) return true;
  return (
    state.agentStatus === "streaming" ||
    state.agentStatus === "between_operations" ||
    state.agentStatus === "retrying" ||
    state.agentStatus === "compacting"
  );
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
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  const [input, setInput] = useState("");
  const [lastCommandResponse, setLastCommandResponse] = useState<AgentCommandResponse | null>(null);

  // True sources: stream projection (+ local clearError / command-error reducers)
  // and optimistic sending. Never put `sending` into contract PiStreamState.
  const streamStateRef = useRef<PiStreamState>(createPiStreamState());
  const sendingRef = useRef(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const readyRef = useRef(false);
  /** Bumps on every session identity change; late SSE/command responses must match. */
  const epochRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  /**
   * Subscription identity — reset React state during render when it changes so
   * a prior session never paints for one frame after switch (matches useWikiRun).
   */
  const subscriptionKey = `${workspaceId}:${sessionId ?? ""}:${rootPath ?? ""}`;
  const subscriptionKeyRef = useRef(subscriptionKey);
  if (subscriptionKeyRef.current !== subscriptionKey) {
    subscriptionKeyRef.current = subscriptionKey;
    epochRef.current += 1;
    streamStateRef.current = createPiStreamState();
    sendingRef.current = false;
    readyRef.current = false;
    setView(viewFromStream(createPiStreamState(), false));
    setReady(false);
    setSessionUsage(null);
    setLastCommandResponse(null);
    setConnectionStatus(sessionId ? "connecting" : "offline");
  }

  const eventsUrl = useMemo(
    () => (sessionId ? agentSessionEventsUrl(workspaceId, sessionId, rootPath) : null),
    [workspaceId, sessionId, rootPath],
  );

  /** Publish stream state → ref + derived React view (messages/status/error). */
  const publish = useCallback((state: PiStreamState, epoch?: number) => {
    if (epoch !== undefined && epoch !== epochRef.current) return;
    streamStateRef.current = state;
    // Clear optimistic sending once SSE owns the turn or settles to idle/error.
    if (sendingRef.current) {
      if (streamTurnActive(state) || state.agentStatus === "idle" || state.agentStatus === "error") {
        // Keep sending only until first stream evidence of the turn OR terminal idle/error.
        // After admission, agent_start sets streaming; after settle, idle/error.
        if (streamTurnActive(state) || state.agentStatus === "error") {
          sendingRef.current = false;
        } else if (state.agentStatus === "idle" && !state.turnActive) {
          // Settled without ever seeing streaming (e.g. empty/fast fixture) — clear sending.
          sendingRef.current = false;
        }
      }
    }
    setView(viewFromStream(state, sendingRef.current));
  }, []);

  /** Refresh view after toggling sending without a stream change. */
  const publishSending = useCallback((sending: boolean, epoch?: number) => {
    if (epoch !== undefined && epoch !== epochRef.current) return;
    sendingRef.current = sending;
    setView(viewFromStream(streamStateRef.current, sending));
  }, []);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;

    const epoch = epochRef.current;

    if (!eventsUrl || typeof EventSource === "undefined") {
      setConnectionStatus("offline");
      return;
    }

    // sessionId set, stream opening — waiting for first snapshot
    setConnectionStatus("connecting");

    const source = new EventSource(eventsUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      if (epoch !== epochRef.current) return;
      // OPEN but not ready until snapshot arrives (or after reconnect until next snapshot)
      if (readyRef.current) {
        setConnectionStatus("live");
      } else {
        setConnectionStatus("connecting");
      }
    };

    source.onmessage = (message) => {
      if (epoch !== epochRef.current) return;
      let event: AgentSseLike;
      try {
        const parsed = AgentSseEventSchema.safeParse(JSON.parse(message.data));
        if (!parsed.success) return;
        event = parsed.data;
        // Drop frames from a prior session identity.
        if (sessionIdRef.current && event.sessionId !== sessionIdRef.current) return;
      } catch {
        return;
      }

      const next = projectAgentEvent(streamStateRef.current, event);
      publish(next, epoch);

      if (event.source === "server" && event.kind === "snapshot") {
        setReady(true);
        readyRef.current = true;
        setConnectionStatus("live");
        // Snapshot fully replaces usage (including clear when absent).
        setSessionUsage(event.payload.sessionUsage ?? null);
      } else if (
        event.source === "server" &&
        event.kind === "stream" &&
        event.payload.sessionUsage
      ) {
        // Stream patches only carry sessionUsage on change — merge when present.
        setSessionUsage(event.payload.sessionUsage);
      }
      // status/error for render come solely from publish → viewFromStream.
      // Optimistic sending clears when SSE turnActive/settled arrives (publish).
    };

    // Native EventSource reconnects. Each reconnect receives a fresh snapshot,
    // which replaces local state; no client replay cursor or ring is needed.
    source.onerror = () => {
      if (epoch !== epochRef.current) return;
      if (source.readyState === EventSource.CLOSED) {
        setReady(false);
        readyRef.current = false;
        setConnectionStatus("offline");
        // Preserve projected error; otherwise settle display status to idle.
        // (Does not rewrite connectionStatus/ready model — only agent view.)
        const current = streamStateRef.current;
        if (current.agentStatus !== "error") {
          publish({ ...current, agentStatus: "idle", turnActive: false }, epoch);
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
      const epoch = epochRef.current;
      const response = await agentSessionCommand(workspaceId, sessionId, command, rootPath);
      if (epoch !== epochRef.current) return null;
      setLastCommandResponse(response);
      return response;
    },
    [workspaceId, sessionId, rootPath],
  );

  const send = useCallback(
    async (text?: string) => {
      const value = (text ?? input).trim();
      if (!sessionId || !value || sendingRef.current) return;

      // Composer queue semantics (Phase 6): normal prompt is idle-only;
      // when running (between operations / streaming), use steer/follow_up
      // queue command. Abort is independent.
      const sendType = streamTurnActive(streamStateRef.current) ? "steer" : "prompt";
      const epoch = epochRef.current;
      publishSending(true, epoch);
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
      publish(
        {
          ...base,
          messages: [...base.messages, optimistic],
          agentStatus: base.agentStatus === "error" ? "idle" : base.agentStatus,
        },
        epoch,
      );

      // Command failure produces no server snapshot — roll the optimistic row
      // back explicitly so a rejected message never looks sent.
      const rollbackOptimistic = () => {
        if (epoch !== epochRef.current) return;
        const current = streamStateRef.current;
        publish(
          {
            ...current,
            messages: current.messages.filter((m) => m.id !== optimistic.id),
          },
          epoch,
        );
      };

      try {
        const response = await runCommand({ type: sendType, text: value });
        if (epoch !== epochRef.current) return;
        if (isCommandFailed(response)) {
          rollbackOptimistic();
          publish(
            withLocalError(streamStateRef.current, response?.message ?? "Agent command failed"),
            epoch,
          );
          publishSending(false, epoch);
          return;
        }
        // Successful admission (202): keep sending until Session SSE shows
        // turnActive/streaming or settles. Do not clear solely on HTTP return.
        if (response?.acceptedTurnId && !streamTurnActive(streamStateRef.current)) {
          // Still waiting for first stream event — leave sending true.
        } else if (streamTurnActive(streamStateRef.current)) {
          publishSending(false, epoch);
        }
      } catch (caught) {
        if (epoch !== epochRef.current) return;
        rollbackOptimistic();
        publish(
          withLocalError(
            streamStateRef.current,
            caught instanceof Error ? caught.message : String(caught),
          ),
          epoch,
        );
        publishSending(false, epoch);
      }
    },
    [input, sessionId, publish, publishSending, runCommand],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    const epoch = epochRef.current;
    try {
      const response = await runCommand({ type: "abort" });
      if (epoch !== epochRef.current) return;
      if (isCommandFailed(response)) {
        publish(
          withLocalError(streamStateRef.current, response?.message ?? "Abort failed"),
          epoch,
        );
        return;
      }
    } catch (caught) {
      if (epoch !== epochRef.current) return;
      publish(
        withLocalError(
          streamStateRef.current,
          caught instanceof Error ? caught.message : String(caught),
        ),
        epoch,
      );
      return;
    }
    // Projector-only surface: do not synthesize local state here. Pi's own
    // message_end(aborted) / agent_settled events finalize the partial stream
    // and settle status back to idle.
  }, [sessionId, runCommand, publish]);

  const setModel = useCallback(
    async (profileId: string): Promise<boolean> => {
      const epoch = epochRef.current;
      publish(clearErrorFromState(streamStateRef.current), epoch);
      try {
        const response = await runCommand({ type: "set_model", profileId });
        if (epoch !== epochRef.current) return false;
        if (isCommandFailed(response)) {
          // Banner only — keep agentStatus so Composer does not flip to error.
          publish(
            {
              ...streamStateRef.current,
              errorText: response?.message ?? "Model switch failed",
            },
            epoch,
          );
          return false;
        }
        return true;
      } catch (caught) {
        if (epoch !== epochRef.current) return false;
        publish(
          {
            ...streamStateRef.current,
            errorText: caught instanceof Error ? caught.message : String(caught),
          },
          epoch,
        );
        return false;
      }
    },
    [runCommand, publish],
  );

  const clearError = useCallback(() => {
    publish(clearErrorFromState(streamStateRef.current), epochRef.current);
  }, [publish]);

  return {
    messages: view.messages,
    streamingMessage: view.streamingMessage,
    status: view.status,
    ready,
    connectionStatus,
    error: view.error,
    sessionUsage,
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
