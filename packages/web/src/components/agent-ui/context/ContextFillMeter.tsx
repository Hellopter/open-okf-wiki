import {
  type ContextPhase,
  formatContextFill,
  type SessionUsage,
} from "@okf-wiki/contract";
import { cn } from "@/lib/utils";
import {
  contextPhaseRingClass,
  contextPhaseTextClass,
  isContextNearLimit,
} from "./context-phase";

export type ContextFillMeterProps = {
  usage: SessionUsage | null | undefined;
  phase?: ContextPhase | null;
  /** Show the `12.4k / 128k` label next to the ring (default true). */
  showLabel?: boolean;
  className?: string;
  "data-testid"?: string;
};

const RING_SIZE = 14;
const RING_STROKE = 2;

/**
 * Compact context-fill ring + optional label.
 * Hidden when `formatContextFill` returns null (nothing useful to show).
 */
export function ContextFillMeter({
  usage,
  phase,
  showLabel = true,
  className,
  "data-testid": testId = "context-fill-meter",
}: ContextFillMeterProps) {
  const view = formatContextFill(usage);
  if (!view) return null;

  const percent = view.percent ?? 0;
  const r = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const dashOffset = circumference - (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  const nearLimit = isContextNearLimit(phase);
  const ringClass = contextPhaseRingClass(phase);
  const textClass = contextPhaseTextClass(phase);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 tabular-nums",
        textClass,
        nearLimit && "font-medium",
        className,
      )}
      data-testid={testId}
      data-phase={phase ?? "unknown"}
      data-near-limit={nearLimit || undefined}
    >
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className={cn(
          "shrink-0",
          phase === "compacting" && "animate-spin motion-reduce:animate-none",
        )}
        aria-hidden
      >
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          fill="none"
          className="stroke-muted-foreground/25"
          strokeWidth={RING_STROKE}
        />
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={r}
          fill="none"
          className={ringClass}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={view.percent == null ? circumference : dashOffset}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      </svg>
      {showLabel ? (
        <span className="max-w-[9rem] truncate text-xs tracking-tight">{view.label}</span>
      ) : null}
    </span>
  );
}
