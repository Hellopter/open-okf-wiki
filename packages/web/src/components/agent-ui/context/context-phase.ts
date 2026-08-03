/**
 * Pure context-fill phase → chrome tone mapping (semantic tokens only).
 */
import type { ContextPhase } from "@okf-wiki/contract/session";
import type { StatusTone } from "../status";

/** Map server context pressure phase to StatusTone for meter chrome. */
export function contextPhaseTone(phase: ContextPhase | undefined | null): StatusTone {
  switch (phase) {
    case "approaching_target":
      return "warning";
    case "at_target":
      return "destructive";
    case "compacting":
      return "info";
    case "normal":
    case "unknown":
    default:
      return "neutral";
  }
}

/** Near operational target — show compact hint in tooltip / warning meter. */
export function isContextNearLimit(phase: ContextPhase | undefined | null): boolean {
  return phase === "approaching_target" || phase === "at_target";
}

/** Ring stroke classes for the context fill meter (semantic tokens). */
export function contextPhaseRingClass(phase: ContextPhase | undefined | null): string {
  switch (contextPhaseTone(phase)) {
    case "warning":
      return "stroke-warning";
    case "destructive":
      return "stroke-destructive";
    case "info":
      return "stroke-info";
    default:
      return "stroke-muted-foreground";
  }
}

/** Label text classes for the context fill meter. */
export function contextPhaseTextClass(phase: ContextPhase | undefined | null): string {
  switch (contextPhaseTone(phase)) {
    case "warning":
      return "text-warning";
    case "destructive":
      return "text-destructive";
    case "info":
      return "text-info";
    default:
      return "text-muted-foreground";
  }
}
