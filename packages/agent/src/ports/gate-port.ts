/**
 * HITL gate port for plan confirm and publication approve/deny.
 *
 * Product-owned (Pi has no HITL). Types live here so workflow/run-wiki and
 * tools can share one DIP surface without coupling to produce/.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";

export type GateDecision = {
  action: "approve" | "deny" | "revise";
  feedback?: string;
  spec?: WikiRunSpec;
};

export type GateRequest = {
  toolCallId: string;
  runId: string;
  gate: "plan" | "publication";
  spec: WikiRunSpec;
  pages: string[];
};

/**
 * Wait for an operator gate decision (plan or publication).
 * Implementations live in server (live HITL) or tests (auto-approve fakes).
 */
export interface GatePort {
  waitForDecision(request: GateRequest, signal?: AbortSignal): Promise<GateDecision>;
}
