import { formatContextFill, type SessionUsage } from "@okf-wiki/contract/session";
import type { ContextPhase } from "@okf-wiki/contract/session";
import { cn } from "@/lib/utils";
import { contextPhaseRingClass, isContextNearLimit } from "./context-phase";

export type ContextFillMicroDotProps = {
  usage: SessionUsage | null | undefined;
  phase?: ContextPhase | null;
  /** When set, exposed to assistive tech (otherwise decorative). */
  ariaLabel?: string;
  className?: string;
  "data-testid"?: string;
};

const DOT_SIZE = 8;
const DOT_STROKE = 1.5;

/**
 * Tiny context-fill ring for Run Graph nodes.
 * Hidden when formatContextFill returns null. Keeps graph chrome small.
 */
export function ContextFillMicroDot({
  usage,
  phase,
  ariaLabel,
  className,
  "data-testid": testId = "context-fill-micro-dot",
}: ContextFillMicroDotProps) {
  const view = formatContextFill(usage);
  if (!view) return null;

  const percent = view.percent;
  const r = (DOT_SIZE - DOT_STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset =
    percent == null
      ? circumference * 0.65
      : circumference - (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  const nearLimit = isContextNearLimit(phase);
  const ringClass = contextPhaseRingClass(phase);

  return (
    <span
      className={cn("inline-flex shrink-0 items-center", className)}
      data-testid={testId}
      data-phase={phase ?? "unknown"}
      data-percent={percent == null ? undefined : String(Math.round(percent))}
      data-near-limit={nearLimit || undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <svg
        width={DOT_SIZE}
        height={DOT_SIZE}
        viewBox={`0 0 ${DOT_SIZE} ${DOT_SIZE}`}
        className="shrink-0"
      >
        <circle
          cx={DOT_SIZE / 2}
          cy={DOT_SIZE / 2}
          r={r}
          fill="none"
          className="stroke-muted-foreground/30"
          strokeWidth={DOT_STROKE}
        />
        <circle
          cx={DOT_SIZE / 2}
          cy={DOT_SIZE / 2}
          r={r}
          fill="none"
          className={ringClass}
          strokeWidth={DOT_STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          opacity={percent == null ? 0.55 : 1}
          transform={`rotate(-90 ${DOT_SIZE / 2} ${DOT_SIZE / 2})`}
        />
      </svg>
    </span>
  );
}
