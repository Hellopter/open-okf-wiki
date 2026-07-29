/**
 * Durable WikiRuns projection for one runId (ADR 0035).
 *
 * Truth: GET snapshot + EventSource `…/runs/:runId/events`.
 * Heartbeat comment frames are ignored by EventSource.
 * Each frame carries a full secret-free snapshot — replace by event id only
 * (never merge node maps in React). Optimistic UI is limited to in-flight
 * command sends in the panel, not a second control state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWikiRun, wikiRunEventsUrl } from "../../api";
import {
  applyWikiRunFrame,
  emptyWikiRunProjection,
  parseWikiRunSseData,
  type WikiRunProjection,
  type WikiRunSseFrame,
} from "./project-wiki-run";
import type { ConnectionStatus } from "./useSessionAgent";

export type {
  WikiRunProjection,
  WikiRunSseFrame,
} from "./project-wiki-run";
export {
  applyWikiRunFrame,
  emptyWikiRunProjection,
  parseWikiRunSseData,
} from "./project-wiki-run";

export type UseWikiRunArgs = {
  workspaceId: string;
  runId: string | null | undefined;
  rootPath?: string;
  /** When false, do not open GET/SSE (e.g. inspector closed). Default true. */
  enabled?: boolean;
};

export type UseWikiRunResult = {
  snapshot: import("@okf-wiki/contract").WikiRunSnapshot | null;
  /** Last applied WikiRuns SSE cursor (monotone event id). */
  cursor: number | null;
  ready: boolean;
  connectionStatus: ConnectionStatus;
  error: string | null;
  eventsUrl: string | null;
  /** Re-fetch GET snapshot (does not close SSE). */
  refresh: () => Promise<void>;
};

export function useWikiRun({
  workspaceId,
  runId,
  rootPath,
  enabled = true,
}: UseWikiRunArgs): UseWikiRunResult {
  const [projection, setProjection] = useState<WikiRunProjection>(emptyWikiRunProjection);
  const [ready, setReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");

  const projectionRef = useRef(projection);
  const eventSourceRef = useRef<EventSource | null>(null);
  const readyRef = useRef(false);

  const eventsUrl = useMemo(() => {
    if (!enabled || !runId || !workspaceId) return null;
    return wikiRunEventsUrl(workspaceId, runId, rootPath);
  }, [enabled, runId, workspaceId, rootPath]);

  const publish = useCallback((next: WikiRunProjection) => {
    projectionRef.current = next;
    setProjection(next);
  }, []);

  const applyFrame = useCallback(
    (frame: WikiRunSseFrame) => {
      const next = applyWikiRunFrame(projectionRef.current, frame);
      publish(next);
      if (next.snapshot) {
        setReady(true);
        readyRef.current = true;
      }
    },
    [publish],
  );

  const refresh = useCallback(async () => {
    if (!enabled || !runId || !workspaceId) return;
    try {
      const { snapshot, cursor } = await getWikiRun(workspaceId, runId, rootPath);
      applyFrame({ kind: "snapshot", cursor, snapshot });
    } catch (error) {
      applyFrame({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [enabled, runId, workspaceId, rootPath, applyFrame]);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    projectionRef.current = emptyWikiRunProjection();
    publish(emptyWikiRunProjection());
    setReady(false);
    readyRef.current = false;

    if (!eventsUrl || !runId || !workspaceId || typeof EventSource === "undefined") {
      setConnectionStatus("offline");
      return;
    }

    let cancelled = false;
    setConnectionStatus("connecting");

    // GET first for immediate paint; SSE then replaces/advances by event id.
    void (async () => {
      try {
        const { snapshot, cursor } = await getWikiRun(workspaceId, runId, rootPath);
        if (cancelled) return;
        applyFrame({ kind: "snapshot", cursor, snapshot });
      } catch (error) {
        if (cancelled) return;
        applyFrame({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    const source = new EventSource(eventsUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      if (readyRef.current) setConnectionStatus("live");
      else setConnectionStatus("connecting");
    };

    const onFrame = (eventName: string) => (message: MessageEvent<string>) => {
      const frame = parseWikiRunSseData(eventName, message.data);
      if (!frame) return;
      applyFrame(frame);
      if (frame.kind !== "error") setConnectionStatus("live");
    };

    source.addEventListener("snapshot", onFrame("snapshot") as EventListener);
    source.addEventListener("run.event", onFrame("run.event") as EventListener);

    // Named events only — onmessage would ignore typed frames; leave unset.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setReady(false);
        readyRef.current = false;
        setConnectionStatus("offline");
        return;
      }
      setConnectionStatus("reconnecting");
    };

    return () => {
      cancelled = true;
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [eventsUrl, runId, workspaceId, rootPath, applyFrame, publish]);

  return {
    snapshot: projection.snapshot,
    cursor: projection.cursor,
    ready,
    connectionStatus,
    error: projection.error,
    eventsUrl,
    refresh,
  };
}
