/**
 * Pending wiki_produce gate waiters for live Operator Sessions.
 * Gate keys are sessionKey(workspaceId, sessionId) — one pending gate per session.
 */

import type { GateDecision, GatePort, GateRequest } from "@okf-wiki/agent";
import { sessionKey } from "../session-key.ts";

export type PendingGate = {
  request: GateRequest;
  resolve: (decision: GateDecision) => void;
  reject: (error: Error) => void;
  detachAbort?: () => void;
};

const pendingGates = new Map<string, PendingGate>();

/** Lookup a pending gate by session key (used by resume_gate and delete). */
export function getPendingGate(key: string): PendingGate | undefined {
  return pendingGates.get(key);
}

/** Reject and remove a pending gate if present (delete mid-gate, H3). */
export function rejectPendingGate(key: string, error: Error): void {
  pendingGates.get(key)?.reject(error);
}

/** True when a session has an outstanding gate waiter (idle sweep skip). */
export function hasPendingGate(key: string): boolean {
  return pendingGates.has(key);
}

/** Reject every waiter and clear the map (test reset). */
export function clearAllPendingGates(reason: string): void {
  for (const pending of pendingGates.values()) pending.reject(new Error(reason));
  pendingGates.clear();
}

/** Build a GatePort bound to one Operator Session. */
export function gateCoordinator(workspaceId: string, sessionId: string): GatePort {
  return {
    waitForDecision(request, signal) {
      const key = sessionKey(workspaceId, sessionId);
      if (pendingGates.has(key)) {
        return Promise.reject(new Error("Operator Session already has a pending Wiki Run gate"));
      }
      return new Promise<GateDecision>((resolve, reject) => {
        const pending: PendingGate = {
          request,
          resolve: (decision) => {
            pending.detachAbort?.();
            pendingGates.delete(key);
            resolve(decision);
          },
          reject: (error) => {
            pending.detachAbort?.();
            pendingGates.delete(key);
            reject(error);
          },
        };
        if (signal) {
          const abort = () => pending.reject(new Error("Wiki Run cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          pending.detachAbort = () => signal.removeEventListener("abort", abort);
        }
        pendingGates.set(key, pending);
      });
    },
  };
}
