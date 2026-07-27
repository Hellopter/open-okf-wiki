/**
 * HITL plan / publication gate loops (ADR 0032 / 0033).
 *
 * Coalesces awaitGate + deny/revise/approve branches so run-wiki stays a thin
 * orchestrator. Side effects (phase, Run Record, commit, topology, re-plan)
 * are injected — this module has no Pi SDK or tools/ imports.
 */

import {
  type WikiProduceToolDetails,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import type { GateDecision, GatePort, GateRequest } from "../ports/gate-port.js";
import type { AdvancePhase } from "./run-phase-writer.js";

export type { AdvancePhase, AdvancePhaseOptions } from "./run-phase-writer.js";

export type PlanGateLoopInput = {
  coordinator: GatePort;
  toolCallId: string;
  runId: string;
  signal?: AbortSignal;
  initialSpec: WikiRunSpec;
  runPlanner: (priorSpec?: WikiRunSpec, revisionFeedback?: string) => Promise<WikiRunSpec>;
  /** Commit living Spec; return value ignored (may be path string from commitSpec). */
  commitSpec: (spec: WikiRunSpec) => Promise<unknown>;
  publishTopology: (spec: WikiRunSpec) => Promise<unknown>;
  /** Unified phase + record write (persist stays with the shell). */
  advancePhase: AdvancePhase;
};

export type PlanGateLoopResult =
  | { action: "approved"; spec: WikiRunSpec }
  | { action: "declined"; spec: WikiRunSpec };

export type PublicationGateLoopInput = {
  coordinator: GatePort;
  toolCallId: string;
  runId: string;
  signal?: AbortSignal;
  spec: WikiRunSpec;
  pages: string[];
  /** Summary written to the Run Record while awaiting publication. */
  recordSummary?: string;
  defects?: WikiProduceToolDetails["defects"];
  /** Unified phase + record write (persist stays with the shell). */
  advancePhase: AdvancePhase;
};

export type PublicationGateLoopResult = { action: "approve" } | { action: "declined" };

function abortError(): Error {
  const error = new Error("Wiki Run cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Wait for a gate decision, racing AbortSignal so cancel never hangs on HITL.
 * Registers the pending gate before the caller publishes awaiting_* phase so
 * operator resume_gate cannot race an empty pending map (caller order).
 */
export async function awaitGate(
  coordinator: GatePort,
  request: GateRequest,
  signal?: AbortSignal,
): Promise<GateDecision> {
  throwIfAborted(signal);
  if (!signal) return coordinator.waitForDecision(request);
  return new Promise<GateDecision>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void coordinator.waitForDecision(request, signal).then(
      (decision) => {
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Parse operator-supplied Spec override once per decision (approve/revise).
 * Decision.spec is typed but may arrive from the wire without prior Zod parse.
 */
function parseDecisionSpec(spec: WikiRunSpec): WikiRunSpec {
  return WikiRunSpecSchema.parse(spec);
}

/**
 * Plan confirm HITL: deny → declined; revise → re-plan and re-gate; approve → done.
 * Spec override on approve/revise is parsed at most once per decision.
 */
export async function runPlanGateLoop(input: PlanGateLoopInput): Promise<PlanGateLoopResult> {
  let spec = input.initialSpec;

  for (;;) {
    // Register the pending gate BEFORE publishing awaiting_plan so operator
    // resume_gate never races an empty pendingGates map. The per-gate abort
    // lets us withdraw the registration if the Run Record write fails below.
    const gateAbort = new AbortController();
    const gateSignal = input.signal
      ? AbortSignal.any([input.signal, gateAbort.signal])
      : gateAbort.signal;
    const decisionPromise = awaitGate(
      input.coordinator,
      {
        toolCallId: input.toolCallId,
        runId: input.runId,
        gate: "plan",
        spec,
        pages: [],
      },
      gateSignal,
    );
    // Abort may land while we write the Run Record — keep the promise
    // "handled" so Node does not emit unhandledRejection before we await.
    void decisionPromise.catch(() => undefined);

    try {
      await input.advancePhase("awaiting_plan", {
        extra: {
          runId: input.runId,
          spec,
          summary: "Awaiting WikiRunSpec approval",
        },
        record: {
          spec,
          summary: "Awaiting WikiRunSpec approval",
        },
      });
    } catch (error) {
      // Withdraw the pending gate so the coordinator is not left with a
      // decision nobody will consume.
      gateAbort.abort();
      throw error;
    }

    const decision = await decisionPromise;

    if (decision.action === "deny") {
      await input.advancePhase("cancelled", {
        extra: {
          summary: "WikiRunSpec declined by operator",
        },
        record: {
          spec,
          summary: "WikiRunSpec declined by operator",
        },
      });
      return { action: "declined", spec };
    }

    // Single parse for this decision when an operator Spec override is present.
    const overrideSpec = decision.spec ? parseDecisionSpec(decision.spec) : undefined;

    if (decision.action === "revise") {
      const prior = overrideSpec ?? spec;
      spec = await input.runPlanner(
        prior,
        decision.feedback?.trim() || "Re-evaluate the WikiRunSpec against frozen sources.",
      );
      await input.commitSpec(spec);
      await input.publishTopology(spec);
      continue;
    }

    // approve (or any non-deny/non-revise action treated as approve)
    if (overrideSpec) {
      spec = overrideSpec;
      await input.commitSpec(spec);
      await input.publishTopology(spec);
    }
    return { action: "approved", spec };
  }
}

/**
 * Publication HITL: approve continues to publish; any other action declines
 * (Staging Wiki retained). Single-shot — no revise loop.
 */
export async function runPublicationGateLoop(
  input: PublicationGateLoopInput,
): Promise<PublicationGateLoopResult> {
  const gateAbort = new AbortController();
  const gateSignal = input.signal
    ? AbortSignal.any([input.signal, gateAbort.signal])
    : gateAbort.signal;
  const decisionPromise = awaitGate(
    input.coordinator,
    {
      toolCallId: input.toolCallId,
      runId: input.runId,
      gate: "publication",
      spec: input.spec,
      pages: input.pages,
    },
    gateSignal,
  );
  void decisionPromise.catch(() => undefined);

  try {
    await input.advancePhase("awaiting_publication", {
      extra: {
        spec: input.spec,
        pages: input.pages,
        summary: "Awaiting publication approval",
        defects: input.defects ?? undefined,
      },
      record: {
        spec: input.spec,
        pages: input.pages,
        summary: input.recordSummary,
      },
    });
  } catch (error) {
    // Withdraw the pending gate so the coordinator is not left with a
    // decision nobody will consume.
    gateAbort.abort();
    throw error;
  }

  const decision = await decisionPromise;
  if (decision.action === "approve") {
    return { action: "approve" };
  }

  await input.advancePhase("publication_declined", {
    extra: {
      summary: "Publication declined; Staging Wiki retained",
    },
    record: {
      spec: input.spec,
      pages: input.pages,
      summary: "Publication declined; Staging Wiki retained",
    },
  });
  return { action: "declined" };
}
