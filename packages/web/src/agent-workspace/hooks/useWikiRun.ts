/**
 * Durable WikiRuns projection for one runId (ADR 0035 / Phase 6).
 *
 * Truth: GET snapshot + EventSource `…/runs/:runId/events`.
 * Shell subscribes to the URL `?run=` only (one EventSource per workspace shell).
 * Heartbeat comment frames are ignored by EventSource.
 * Each frame carries a full secret-free snapshot — replace by event id only
 * (never merge node maps in React). Optimistic UI is limited to resource-keyed
 * in-flight command sends (`run:id:cancel` / `gate:id:resolve` / `node:id:retry`);
 * HTTP accept/reject is admission only — Run SSE is truth.
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
  /** When false, do not open GET/SSE (e.g. no active runId). Default true. */
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
  enabled = true,
}: UseWikiRunArgs): UseWikiRunResult {
  const [projection, setProjection] = useState<WikiRunProjection>(emptyWikiRunProjection);
  const [ready, setReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("offline");

  const projectionRef = useRef(projection);
  const eventSourceRef = useRef<EventSource | null>(null);
  const readyRef = useRef(false);
  /** Bumps on every subscription identity change; late GET/SSE frames must match. */
  const epochRef = useRef(0);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  /**
   * Subscription identity — reset React state during render when it changes so
   * Gate/Inspector never paint the previous run for one frame (Batch 2 race).
   */
  const subscriptionKey = `${enabled ? "1" : "0"}:${workspaceId}:${runId ?? ""}`;
  const subscriptionKeyRef = useRef(subscriptionKey);
  if (subscriptionKeyRef.current !== subscriptionKey) {
    subscriptionKeyRef.current = subscriptionKey;
    epochRef.current += 1;
    projectionRef.current = emptyWikiRunProjection();
    readyRef.current = false;
    setProjection(emptyWikiRunProjection());
    setReady(false);
    setConnectionStatus("offline");
  }

  const eventsUrl = useMemo(() => {
    if (!enabled || !runId || !workspaceId) return null;
    return wikiRunEventsUrl(workspaceId, runId);
  }, [enabled, runId, workspaceId]);

  const publish = useCallback((next: WikiRunProjection) => {
    projectionRef.current = next;
    setProjection(next);
  }, []);

  const applyFrame = useCallback(
    (frame: WikiRunSseFrame, epoch: number) => {
      // Drop frames from a prior runId/enabled subscription (late SSE / in-flight GET).
      if (epoch !== epochRef.current) return;
      if (frame.kind === "snapshot" || frame.kind === "run.event") {
        const snap = frame.kind === "snapshot" ? frame.snapshot : frame.event.snapshot;
        const expected = runIdRef.current;
        if (expected && snap.runId !== expected) return;
      }
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
    const epoch = epochRef.current;
    try {
      const { snapshot, cursor } = await getWikiRun(workspaceId, runId);
      applyFrame({ kind: "snapshot", cursor, snapshot }, epoch);
    } catch (error) {
      applyFrame(
        {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        },
        epoch,
      );
    }
  }, [enabled, runId, workspaceId, applyFrame]);

  useEffect(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    // Align with render reset; capture epoch for this effect instance.
    const epoch = epochRef.current;
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
        const { snapshot, cursor } = await getWikiRun(workspaceId, runId);
        if (cancelled) return;
        applyFrame({ kind: "snapshot", cursor, snapshot }, epoch);
      } catch (error) {
        if (cancelled) return;
        applyFrame(
          {
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          },
          epoch,
        );
      }
    })();

    const source = new EventSource(eventsUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      if (epoch !== epochRef.current) return;
      if (readyRef.current) setConnectionStatus("live");
      else setConnectionStatus("connecting");
    };

    const onFrame = (eventName: string) => (message: MessageEvent<string>) => {
      const frame = parseWikiRunSseData(eventName, message.data);
      if (!frame) return;
      applyFrame(frame, epoch);
      if (frame.kind !== "error" && epoch === epochRef.current) {
        setConnectionStatus("live");
      }
    };

    source.addEventListener("snapshot", onFrame("snapshot") as EventListener);
    source.addEventListener("run.event", onFrame("run.event") as EventListener);

    // Named events only — onmessage would ignore typed frames; leave unset.
    source.onerror = () => {
      if (epoch !== epochRef.current) return;
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
  }, [eventsUrl, runId, workspaceId, applyFrame, publish]);

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
