import { createSessionStreamState, type SessionStreamState, viewSessionMessages } from "@okf-wiki/contract/session";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agentSessionCommand, agentSessionEventsUrl, parseAgentSessionEvent } from "../api";
import { planSessionSend } from "../components/agent-ui/context/slash-commands";
import { useI18n } from "../i18n";
import { notifyError } from "../lib/notify";
import { appendOptimisticUser, reduceSessionStreamEvent } from "./session-stream-state";

export type SessionConnection = "connecting" | "live" | "reconnecting" | "offline";

const BUSY_STATUSES = new Set(["streaming", "between_operations", "retrying", "compacting"]);

export function useSessionConversation(
  workspaceId: string,
  sessionId: string | null,
  options?: {
    /** Workspace default model profile when stream has no session model yet. */
    defaultProfileId?: string | null;
  },
) {
  const { t } = useI18n();
  const [streamState, setStreamState] = useState<SessionStreamState>(() =>
    createSessionStreamState(),
  );
  const [connection, setConnection] = useState<SessionConnection>("offline");
  /** Local optimistic model after set_model until stream snapshot/patch confirms. */
  const [localModelProfileId, setLocalModelProfileId] = useState<string | null>(null);

  const messages = useMemo(() => viewSessionMessages(streamState), [streamState]);
  const status = streamState.agentStatus;
  /** Single busy derive for composer, send planning, and stop chrome. */
  const isBusy = BUSY_STATUSES.has(status);
  const sessionUsage = streamState.sessionUsage;
  const contextPhase = streamState.contextPhase;

  // Prefer authoritative stream chrome (snapshot + set_model patches) over optimistic local.
  const currentModelProfileId =
    streamState.model?.profileId ?? localModelProfileId ?? options?.defaultProfileId ?? null;

  useEffect(() => {
    // Reset local model override when switching sessions.
    setLocalModelProfileId(null);
  }, [sessionId]);

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

  const setModel = useCallback(
    async (profileId: string) => {
      if (!sessionId || !profileId.trim()) return false;
      try {
        const result = await agentSessionCommand(workspaceId, sessionId, {
          type: "set_model",
          profileId: profileId.trim(),
        });
        if (!result.ok) throw new Error(result.message ?? t.workbench.commandRejected);
        // Optimistic until the stream patch (or next snapshot) carries session.model.
        setLocalModelProfileId(profileId.trim());
        return true;
      } catch (nextError) {
        notifyError(nextError);
        return false;
      }
    },
    [sessionId, t.workbench.commandRejected, workspaceId],
  );

  const compact = useCallback(
    async (mode?: "idle" | "stop_and_compact") => {
      if (!sessionId) return false;
      try {
        const result = await agentSessionCommand(workspaceId, sessionId, {
          type: "compact",
          ...(mode ? { mode } : {}),
        });
        if (!result.ok) throw new Error(result.message ?? t.workbench.commandRejected);
        return true;
      } catch (nextError) {
        notifyError(nextError);
        return false;
      }
    },
    [sessionId, t.workbench.commandRejected, workspaceId],
  );

  const send = useCallback(
    async (text: string) => {
      if (!sessionId) return false;
      const plan = planSessionSend(text, isBusy);
      if (!plan) return false;

      try {
        // Slash text (control + template) always uses prompt so the server can
        // intercept control before the busy gate (/compact stop → stop_and_compact).
        // Never client-map /compact* to AgentCommand compact(idle).
        const result = await agentSessionCommand(workspaceId, sessionId, plan.command);
        if (!result.ok) throw new Error(result.message ?? t.workbench.commandRejected);
        // Control slash has no user transcript row — skip optimistic bubble.
        if (plan.appendOptimisticUser) {
          setStreamState((previous) => appendOptimisticUser(previous, plan.command.text));
        }
        return true;
      } catch (nextError) {
        notifyError(nextError);
        return false;
      }
    },
    [isBusy, sessionId, t.workbench.commandRejected, workspaceId],
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

  return {
    messages,
    status,
    isBusy,
    connection,
    sessionUsage,
    contextPhase,
    currentModelProfileId,
    setModel,
    compact,
    send,
    abort,
  };
}
