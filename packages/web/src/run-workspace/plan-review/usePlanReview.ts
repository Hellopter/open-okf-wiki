/**
 * Operator plan-review state machine: loads sealed Spec + ExecutionPlan summary
 * keyed by open plan gate payloadDigest (or latest sealed plan when no gate).
 */

import type { WikiRunSnapshot } from "@okf-wiki/contract/wiki-runs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getWikiRunPlanReview, hasApiErrorCode } from "../../api";
import {
  openPlanGateFromSnapshot,
  type PlanReviewState,
  shouldLoadPlanReview,
} from "./plan-review-utils";

export type { PlanReviewState, PlanReviewStatus } from "./plan-review-utils";
export { planReviewHeadline, shouldLoadPlanReview } from "./plan-review-utils";

function isNotFound(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 404) || hasApiErrorCode(error, "not_found")
  );
}

const INITIAL: PlanReviewState = {
  status: "idle",
  review: null,
  error: null,
  expectedPayloadDigest: null,
};

/**
 * Fetch and keep plan-review materials aligned with the open plan gate.
 *
 * @param workspaceId workspace id
 * @param runId active run id (null → idle)
 * @param snapshot live WikiRun snapshot (gate.payloadDigest)
 * @param enabled when false, do not fetch
 */
export function usePlanReview(
  workspaceId: string,
  runId: string | null,
  snapshot: WikiRunSnapshot | null | undefined,
  enabled = true,
): PlanReviewState & { retry: () => void } {
  const [state, setState] = useState<PlanReviewState>(INITIAL);
  const [retryToken, setRetryToken] = useState(0);
  const requestGen = useRef(0);

  const planGate = useMemo(() => openPlanGateFromSnapshot(snapshot?.gates), [snapshot]);
  const expectedPayloadDigest = planGate?.payloadDigest ?? null;
  // Auto-enable when plan is relevant; caller can force off with enabled=false.
  const materialsNeeded = enabled && Boolean(runId) && shouldLoadPlanReview(snapshot);
  const shouldLoad = Boolean(workspaceId && runId && materialsNeeded);

  const retry = useCallback(() => setRetryToken((n) => n + 1), []);

  useEffect(() => {
    if (!shouldLoad || !runId) {
      setState(INITIAL);
      return;
    }

    const gen = ++requestGen.current;
    const controller = new AbortController();
    setState((prev) => ({
      status:
        prev.review &&
        expectedPayloadDigest &&
        prev.review.payloadDigest !== expectedPayloadDigest
          ? "stale"
          : "loading",
      review: prev.review,
      error: null,
      expectedPayloadDigest,
    }));

    void getWikiRunPlanReview(workspaceId, runId, { signal: controller.signal })
      .then((review) => {
        if (gen !== requestGen.current) return;
        if (expectedPayloadDigest && review.payloadDigest !== expectedPayloadDigest) {
          setState({
            status: "stale",
            review,
            error: null,
            expectedPayloadDigest,
          });
          return;
        }
        setState({
          status: "ready",
          review,
          error: null,
          expectedPayloadDigest,
        });
      })
      .catch((error: unknown) => {
        if (gen !== requestGen.current) return;
        if (controller.signal.aborted) return;
        if (isNotFound(error)) {
          setState({
            status: "pending",
            review: null,
            error: null,
            expectedPayloadDigest,
          });
          return;
        }
        setState({
          status: "error",
          review: null,
          error,
          expectedPayloadDigest,
        });
      });

    return () => {
      controller.abort();
    };
    // Re-fetch when open plan gate binding changes or operator retries — not every revision.
  }, [shouldLoad, workspaceId, runId, expectedPayloadDigest, retryToken]);

  // Auto re-fetch once when stale (digest mismatch after a successful load of older materials).
  useEffect(() => {
    if (state.status !== "stale") return;
    const timer = window.setTimeout(() => setRetryToken((n) => n + 1), 400);
    return () => window.clearTimeout(timer);
  }, [state.status]);

  return { ...state, retry };
}
