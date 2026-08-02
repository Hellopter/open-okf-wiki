import type { WikiRunAttempt, WikiRunSpec } from "@okf-wiki/contract";
import {
  WikiRunAttemptTranscriptTraceFrameSchema,
  WikiRunEventSchema,
  WikiRunGetResponseSchema,
} from "@okf-wiki/contract";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getWikiRun,
  getWikiRunAttemptTranscript,
  getWikiRunSpec,
  wikiRunAttemptTranscriptEventsUrl,
  wikiRunEventsUrl,
} from "../api";
import {
  createRunObservationState,
  type FollowMode,
  hydrateAttemptTimeline,
  latestAttemptForNode,
  mergeAttemptTraceFrame,
  type RunObservationState,
  selectObservationNode,
  setObservationSnapshot,
  setTimelineError,
  setTimelineLoadingEarlier,
} from "./observation-state";

export type RunObservationConnection = "connecting" | "live" | "reconnecting" | "offline";

export function useRunObservation(
  workspaceId: string,
  runId: string | null,
  routeAttemptId: string | null,
) {
  const [state, setState] = useState<RunObservationState>(() => createRunObservationState());
  const [spec, setSpec] = useState<WikiRunSpec | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [connection, setConnection] = useState<RunObservationConnection>("offline");

  useEffect(() => {
    if (!workspaceId || !runId) {
      setState(createRunObservationState());
      setSpec(null);
      setConnection("offline");
      return;
    }
    let active = true;
    setState(createRunObservationState());
    setSpec(null);
    setError(null);
    setConnection("connecting");
    void Promise.all([
      getWikiRun(workspaceId, runId),
      getWikiRunSpec(workspaceId, runId).catch(() => null),
    ])
      .then(([run, plan]) => {
        if (!active) return;
        setState((current) => setObservationSnapshot(current, run.snapshot));
        setSpec(plan?.spec ?? null);
      })
      .catch((nextError) => {
        if (active) setError(nextError);
      });

    const source = new EventSource(wikiRunEventsUrl(workspaceId, runId));
    source.addEventListener("snapshot", (event) => {
      try {
        const frame = WikiRunGetResponseSchema.parse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        if (active) {
          setState((current) => setObservationSnapshot(current, frame.snapshot));
          setConnection("live");
        }
      } catch (nextError) {
        if (active) setError(nextError);
      }
    });
    source.addEventListener("run.event", (event) => {
      try {
        const frame = WikiRunEventSchema.parse(JSON.parse((event as MessageEvent<string>).data));
        if (active) {
          setState((current) => setObservationSnapshot(current, frame.snapshot));
          setConnection("live");
        }
      } catch (nextError) {
        if (active) setError(nextError);
      }
    });
    source.onerror = () => {
      if (active) setConnection("reconnecting");
    };
    return () => {
      active = false;
      source.close();
    };
  }, [runId, workspaceId]);

  useEffect(() => {
    if (!routeAttemptId) return;
    setState((current) => {
      // Snapshot frames arrive while an attempt is running. A route selection
      // is applied only once so an operator can explicitly pin live output.
      if (current.selectedAttemptId === routeAttemptId) return current;
      const attempt = current.snapshot?.attempts.find((item) => item.attemptId === routeAttemptId);
      return attempt ? selectObservationNode(current, attempt.nodeKey, attempt.attemptId) : current;
    });
  }, [routeAttemptId, state.snapshot]);

  const selectedAttemptId = state.selectedAttemptId;
  useEffect(() => {
    if (!workspaceId || !runId || !selectedAttemptId) return;
    let active = true;
    let source: EventSource | null = null;
    void getWikiRunAttemptTranscript(workspaceId, runId, selectedAttemptId, { limit: 200 })
      .then((transcript) => {
        if (!active) return;
        setState((current) => hydrateAttemptTimeline(current, transcript));
        if (transcript.state !== "running" && transcript.state !== "suspended") return;
        source = new EventSource(
          wikiRunAttemptTranscriptEventsUrl(workspaceId, runId, selectedAttemptId, {
            after: transcript.cursor,
          }),
        );
        source.addEventListener("trace", (event) => {
          try {
            const frame = WikiRunAttemptTranscriptTraceFrameSchema.parse(
              JSON.parse((event as MessageEvent<string>).data),
            );
            if (active) setState((current) => mergeAttemptTraceFrame(current, frame));
          } catch (nextError) {
            if (active) setError(nextError);
          }
        });
        source.addEventListener("transcript_error", (event) => {
          if (!active) return;
          try {
            const payload = JSON.parse((event as MessageEvent<string>).data) as {
              message?: unknown;
            };
            setError(
              new Error(
                typeof payload.message === "string"
                  ? payload.message
                  : "Attempt transcript stream failed",
              ),
            );
          } catch (nextError) {
            setError(nextError);
          }
          source?.close();
        });
        source.addEventListener("done", () => source?.close());
      })
      .catch((nextError) => {
        if (!active) return;
        setError(nextError);
        setState((current) => setTimelineError(current, selectedAttemptId, nextError));
      });
    return () => {
      active = false;
      source?.close();
    };
  }, [runId, selectedAttemptId, workspaceId]);

  const selectNode = useCallback((nodeKey: string) => {
    setState((current) => selectObservationNode(current, nodeKey));
  }, []);
  const selectAttempt = useCallback((attempt: WikiRunAttempt) => {
    setState((current) => selectObservationNode(current, attempt.nodeKey, attempt.attemptId));
  }, []);
  const setFollowMode = useCallback((followMode: FollowMode) => {
    setState((current) => ({ ...current, followMode }));
  }, []);
  const loadEarlier = useCallback(async () => {
    if (!workspaceId || !runId || !state.selectedAttemptId) return;
    const timeline = state.timelines[state.selectedAttemptId];
    if (!timeline?.hasEarlier || !timeline.nextBefore || timeline.loadingEarlier) return;
    const attemptId = state.selectedAttemptId;
    setState((current) => setTimelineLoadingEarlier(current, attemptId, true));
    try {
      const transcript = await getWikiRunAttemptTranscript(workspaceId, runId, attemptId, {
        before: timeline.nextBefore,
        limit: 200,
      });
      setState((current) => hydrateAttemptTimeline(current, transcript, "earlier"));
    } catch (nextError) {
      setError(nextError);
      setState((current) => setTimelineError(current, attemptId, nextError));
    }
  }, [runId, state.selectedAttemptId, state.timelines, workspaceId]);

  const selectedAttempt = useMemo(
    () =>
      state.snapshot?.attempts.find((attempt) => attempt.attemptId === state.selectedAttemptId) ??
      null,
    [state.selectedAttemptId, state.snapshot],
  );
  const selectedNode = useMemo(
    () => state.snapshot?.nodes.find((node) => node.key === state.selectedNodeKey) ?? null,
    [state.selectedNodeKey, state.snapshot],
  );
  const timeline = selectedAttemptId ? (state.timelines[selectedAttemptId] ?? null) : null;
  const latestSelectedAttempt =
    state.snapshot && state.selectedNodeKey
      ? latestAttemptForNode(state.snapshot, state.selectedNodeKey)
      : null;

  return {
    snapshot: state.snapshot,
    spec,
    error,
    connection,
    selectedNode,
    selectedAttempt,
    selectedAttemptId: state.selectedAttemptId,
    timeline,
    followMode: state.followMode,
    latestSelectedAttempt,
    selectNode,
    selectAttempt,
    setFollowMode,
    loadEarlier,
  };
}
