/**
 * Pure status → visual descriptor mapping for agent UI chrome.
 * Semantic tokens only (success / warning / info / destructive / primary / muted).
 */

export type StatusTone = "neutral" | "info" | "success" | "warning" | "destructive";
export type StatusMotion = "none" | "spin" | "pulse";
export type StatusDescriptor = {
  tone: StatusTone;
  motion: StatusMotion;
  badgeVariant: "default" | "secondary" | "outline" | "destructive";
  /** Tailwind classes for bordered surfaces (graph nodes, rows) */
  surfaceClass: string;
};

export const STATUS_TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

export function statusToneTextClass(tone: StatusTone): string {
  return STATUS_TONE_TEXT[tone];
}

const SURFACE: Record<StatusTone, string> = {
  neutral: "border-border bg-card",
  info: "border-info/50 bg-info/10",
  success: "border-success/50 bg-success/10",
  warning: "border-warning/50 bg-warning/10",
  destructive: "border-destructive/60 bg-destructive/8",
};

/** Active / in-progress primary surface (matches RunGraph running nodes). */
const SURFACE_PRIMARY = "border-primary/70 bg-primary/8";

function descriptor(
  tone: StatusTone,
  motion: StatusMotion,
  badgeVariant: StatusDescriptor["badgeVariant"],
  surfaceClass?: string,
): StatusDescriptor {
  return {
    tone,
    motion,
    badgeVariant,
    surfaceClass: surfaceClass ?? SURFACE[tone],
  };
}

const NEUTRAL_OUTLINE = descriptor("neutral", "none", "outline");

/** Tool call lifecycle: pending | running | done | error */
export function describeToolStatus(status: string): StatusDescriptor {
  switch (status) {
    case "pending":
      return descriptor("neutral", "none", "outline");
    case "running":
      return descriptor("info", "spin", "default", SURFACE_PRIMARY);
    case "done":
      return descriptor("success", "none", "secondary");
    case "error":
      return descriptor("destructive", "none", "destructive");
    default:
      return NEUTRAL_OUTLINE;
  }
}

/**
 * Wiki Run lifecycle states.
 * queued | running | pausing | paused | waiting_for_operator | failed |
 * publication_declined | completed_unpublished | published | cancelling | cancelled
 */
export function describeRunStatus(status: string): StatusDescriptor {
  switch (status) {
    case "queued":
      return descriptor("neutral", "none", "secondary");
    case "running":
      return descriptor("info", "spin", "default", SURFACE_PRIMARY);
    case "pausing":
      return descriptor("warning", "pulse", "outline");
    case "paused":
      return descriptor("warning", "none", "outline");
    case "waiting_for_operator":
      return descriptor("warning", "pulse", "outline");
    case "failed":
      return descriptor("destructive", "none", "destructive");
    case "publication_declined":
      return descriptor("destructive", "none", "destructive");
    case "completed_unpublished":
      return descriptor("success", "none", "secondary");
    case "published":
      return descriptor("success", "none", "default");
    case "cancelling":
      return descriptor("warning", "spin", "outline");
    case "cancelled":
      return descriptor("neutral", "none", "outline");
    default:
      return NEUTRAL_OUTLINE;
  }
}

/**
 * Graph node states:
 * blocked | ready | running | waiting | succeeded | failed | invalidated | cancelled
 */
export function describeNodeStatus(status: string): StatusDescriptor {
  switch (status) {
    case "blocked":
      return descriptor("neutral", "none", "outline");
    case "ready":
      return descriptor("info", "none", "secondary");
    case "running":
      return descriptor("info", "spin", "default", SURFACE_PRIMARY);
    case "waiting":
      return descriptor("warning", "pulse", "outline");
    case "succeeded":
      return descriptor("success", "none", "secondary");
    case "failed":
      return descriptor("destructive", "none", "destructive");
    case "invalidated":
      return descriptor("warning", "none", "outline");
    case "cancelled":
      return descriptor("neutral", "none", "outline");
    default:
      return NEUTRAL_OUTLINE;
  }
}

/** SSE / live connection: connecting | live | reconnecting | offline */
export function describeConnectionStatus(status: string): StatusDescriptor {
  switch (status) {
    case "connecting":
      return descriptor("info", "spin", "secondary");
    case "live":
      return descriptor("success", "none", "secondary");
    case "reconnecting":
      return descriptor("warning", "spin", "outline");
    case "offline":
      return descriptor("destructive", "none", "destructive");
    default:
      return NEUTRAL_OUTLINE;
  }
}

/**
 * Attempt / generation lifecycle:
 * running | succeeded | failed | interrupted | suspended | cancelled
 */
export function describeAttemptStatus(status: string): StatusDescriptor {
  switch (status) {
    case "running":
      return descriptor("info", "spin", "default", SURFACE_PRIMARY);
    case "succeeded":
      return descriptor("success", "none", "secondary");
    case "failed":
      return descriptor("destructive", "none", "destructive");
    case "interrupted":
      return descriptor("warning", "none", "outline");
    case "suspended":
      return descriptor("warning", "pulse", "outline");
    case "cancelled":
      return descriptor("neutral", "none", "outline");
    default:
      return NEUTRAL_OUTLINE;
  }
}

export type StatusKind = "tool" | "run" | "node" | "connection" | "attempt";

/** Dispatch by kind; unknown kind/status → neutral outline. */
export function describeStatus(kind: StatusKind, status: string): StatusDescriptor {
  switch (kind) {
    case "tool":
      return describeToolStatus(status);
    case "run":
      return describeRunStatus(status);
    case "node":
      return describeNodeStatus(status);
    case "connection":
      return describeConnectionStatus(status);
    case "attempt":
      return describeAttemptStatus(status);
    default:
      return NEUTRAL_OUTLINE;
  }
}
