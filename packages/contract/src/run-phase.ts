import { z } from "zod";

/**
 * Canonical Wiki Run job phase (product truth).
 * Record status and wiki_produce tool status are projections of this enum only.
 * Pi tool_execution_* lifecycle is orthogonal and never appears here.
 */
export const WikiRunPhaseSchema = z.enum([
  "freezing",
  "planning",
  "awaiting_plan",
  "producing",
  "awaiting_publication",
  "published",
  "publication_declined",
  "failed",
  "cancelled",
]);

export type WikiRunPhase = z.infer<typeof WikiRunPhaseSchema>;

/**
 * Coarse durable Run Record status (disk / list API).
 * In-flight sub-phases fold to `running`.
 */
export const WikiRunRecordStatusSchema = z.enum([
  "running",
  "awaiting_plan",
  "awaiting_publication",
  "published",
  "publication_declined",
  "failed",
  "cancelled",
]);

export type WikiRunRecordStatus = z.infer<typeof WikiRunRecordStatusSchema>;

/** Live/durable wiki_produce tool details status — same set as WikiRunPhase. */
export const WikiProduceToolStatusSchema = WikiRunPhaseSchema;
export type WikiProduceToolStatus = WikiRunPhase;

/** Project canonical phase → durable Run Record status. */
export function recordStatusFromPhase(phase: WikiRunPhase): WikiRunRecordStatus {
  switch (phase) {
    case "freezing":
    case "planning":
    case "producing":
      return "running";
    default:
      return phase;
  }
}

/** Project canonical phase → wiki_produce tool details status (identity). */
export function toolStatusFromPhase(phase: WikiRunPhase): WikiProduceToolStatus {
  return phase;
}

/** Which operator HITL gate (if any) is open for this phase. */
export function phaseGate(phase: WikiRunPhase): "plan" | "publication" | null {
  if (phase === "awaiting_plan") return "plan";
  if (phase === "awaiting_publication") return "publication";
  return null;
}

/** Whether operator cancel is allowed while in this phase. */
export function phaseAllowsCancel(phase: WikiRunPhase): boolean {
  return (
    phase === "freezing" ||
    phase === "planning" ||
    phase === "producing" ||
    phase === "awaiting_plan" ||
    phase === "awaiting_publication"
  );
}

const ALLOWED_TRANSITIONS: Record<WikiRunPhase, readonly WikiRunPhase[]> = {
  freezing: ["planning", "failed", "cancelled"],
  planning: ["awaiting_plan", "producing", "failed", "cancelled"],
  awaiting_plan: ["planning", "producing", "cancelled", "failed"],
  producing: ["awaiting_publication", "published", "failed", "cancelled"],
  awaiting_publication: ["published", "publication_declined", "cancelled", "failed"],
  published: [],
  publication_declined: [],
  failed: [],
  cancelled: [],
};

/** Whether a phase transition is allowed (product job machine). */
export function isPhaseTransitionAllowed(from: WikiRunPhase, to: WikiRunPhase): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throw if transition is illegal. */
export function assertPhaseTransition(from: WikiRunPhase, to: WikiRunPhase): void {
  if (!isPhaseTransitionAllowed(from, to)) {
    throw new Error(`Illegal WikiRunPhase transition: ${from} → ${to}`);
  }
}
