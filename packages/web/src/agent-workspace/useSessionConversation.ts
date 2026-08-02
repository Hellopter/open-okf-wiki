import {
  createSessionStreamState,
  type SessionStreamState,
  viewSessionMessages,
} from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentSessionCommand, agentSessionEventsUrl, parseAgentSessionEvent } from "../api";
import { useI18n } from "../i18n";
import { notifyError } from "../lib/notify";
import { appendOptimisticUser, reduceSessionStreamEvent } from "./session-stream-state";

export type SessionConnection = "connecting" | "live" | "reconnecting" | "offline";

export function useSessionConversation(workspaceId: string, sessionId: string | null) {
  const { t } = useI18n();
  const [streamState, setStreamState] = useState<SessionStreamState>(() =>
    createSessionStreamState(),
  );
  const [connection, setConnection] = useState<SessionConnection>("offline");
  const messages = useMemo(() => viewSessionMessages(streamState), [streamState]);
  const status = streamState.agentStatus;

  useEffect(() => {
    if (!workspaceId || !sessionId) {
      setStreamState(createSessionStreamState());
      setConnection("offline");
      return;
    }
    let active = true;
    setConnection("connecting");
    const source = new EventSource(agentSessionEventsUrl(workspaceId, sessionId));
    source.onmessage = (event) => {
      if (!active) return;
      try {
        const frame = parseAgentSessionEvent(event.data);
        setStreamState((previous) => reduceSessionStreamEvent(previous, frame));
        // Stream errorText is rendered on the assistant turn; parse failures only affect
        // connection status so the shell banner stays reserved for page-level load errors.
        setConnection("live");
      } catch {
        setConnection("reconnecting");
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
      const trimmed = text.trim();
      const active = ["streaming", "between_operations", "retrying", "compacting"].includes(status);
      try {
        const result = await agentSessionCommand(
          workspaceId,
          sessionId,
          active ? { type: "steer", text: trimmed } : { type: "prompt", text: trimmed },
        );
        if (!result.ok) throw new Error(result.message ?? t.workbench.commandRejected);
        // Instant UX: show user bubble before SSE delivers the real row (prompt + steer).
        setStreamState((previous) => appendOptimisticUser(previous, trimmed));
        return true;
      } catch (nextError) {
        notifyError(nextError);
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
      notifyError(nextError);
    }
  }, [sessionId, t.workbench.stopFailed, workspaceId]);

  return { messages, status, connection, send, abort };
}
