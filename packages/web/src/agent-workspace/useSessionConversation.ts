import { createPiStreamState, type PiStreamState, viewMessages } from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentSessionCommand, agentSessionEventsUrl, parseAgentSessionEvent } from "../api";
import { useI18n } from "../i18n";
import { reduceSessionStreamEvent } from "./session-stream-state";

export type SessionConnection = "connecting" | "live" | "reconnecting" | "offline";

export function useSessionConversation(workspaceId: string, sessionId: string | null) {
  const { t } = useI18n();
  const [streamState, setStreamState] = useState<PiStreamState>(() => createPiStreamState());
  const [connection, setConnection] = useState<SessionConnection>("offline");
  const [error, setError] = useState<unknown>(null);
  const messages = useMemo(() => viewMessages(streamState), [streamState]);
  const status = streamState.agentStatus;

  useEffect(() => {
    if (!workspaceId || !sessionId) {
      setStreamState(createPiStreamState());
      setConnection("offline");
      return;
    }
    let active = true;
    setConnection("connecting");
    setError(null);
    const source = new EventSource(agentSessionEventsUrl(workspaceId, sessionId));
    source.onmessage = (event) => {
      if (!active) return;
      try {
        const frame = parseAgentSessionEvent(event.data);
        setStreamState((previous) => reduceSessionStreamEvent(previous, frame));
        if (frame.kind === "snapshot") setError(null);
        else if (frame.kind === "stream") {
          setError(frame.payload.errorText ? new Error(frame.payload.errorText) : null);
        }
        setConnection("live");
      } catch (nextError) {
        setConnection("reconnecting");
        setError(nextError);
      }
    };
    source.onerror = () => {
      if (active) setConnection("reconnecting");
    };
    return () => {
      active = false;
      source.close();
    };
  }, [sessionId, workspaceId]);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId || !text.trim()) return false;
      setError(null);
      const active = ["streaming", "between_operations", "retrying", "compacting"].includes(status);
      try {
        const result = await agentSessionCommand(
          workspaceId,
          sessionId,
          active ? { type: "steer", text: text.trim() } : { type: "prompt", text: text.trim() },
        );
        if (!result.ok) throw new Error(result.message ?? t.workbench.commandRejected);
        return true;
      } catch (nextError) {
        setError(nextError);
        return false;
      }
    },
    [sessionId, status, t.workbench.commandRejected, workspaceId],
  );

  const abort = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await agentSessionCommand(workspaceId, sessionId, { type: "abort" });
      if (!result.ok) throw new Error(result.message ?? t.workbench.stopFailed);
    } catch (nextError) {
      setError(nextError);
    }
  }, [sessionId, t.workbench.stopFailed, workspaceId]);

  return { messages, status, connection, error, setError, send, abort };
}
