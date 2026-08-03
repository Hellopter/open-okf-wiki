import { formatContextFill, formatTokenCount, type SessionUsage } from "@okf-wiki/contract/session";
import type { ContextPhase } from "@okf-wiki/contract/session";
import { isContextNearLimit } from "./context-phase";

export type ContextFillDetailLabels = {
  window: string;
  target: string;
  tokens: string;
  phase: string;
  phases: Record<ContextPhase, string>;
  /** Hint shown near limit / always as secondary guidance. */
  compactHint: string;
  /** Label for optional insert-/compact control (session composer). */
  insertCompact?: string;
};

export type ContextFillDetailProps = {
  usage: SessionUsage | null | undefined;
  phase?: ContextPhase | null;
  labels: ContextFillDetailLabels;
  /** Insert `/compact` into the composer (session only). */
  onInsertCompact?: () => void;
  className?: string;
};

/**
 * Detail body for context-fill tooltip / popover.
 * Window, target, phase + compact slash hint when near limit.
 */
export function ContextFillDetail({
  usage,
  phase,
  labels,
  onInsertCompact,
  className,
}: ContextFillDetailProps) {
  const view = formatContextFill(usage);
  const resolvedPhase: ContextPhase = phase ?? "unknown";
  const nearLimit = isContextNearLimit(resolvedPhase);
  const phaseLabel = labels.phases[resolvedPhase] ?? labels.phases.unknown;
  const showCompactAffordance = nearLimit || resolvedPhase === "compacting";

  return (
    <div className={className} data-testid="context-fill-detail">
      <div className="flex flex-col gap-1 text-left">
        {view ? (
          <div className="font-medium tabular-nums">{view.label}</div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.7rem] opacity-90">
          {typeof usage?.contextTokens === "number" ? (
            <>
              <dt>{labels.tokens}</dt>
              <dd className="tabular-nums">{formatTokenCount(usage.contextTokens)}</dd>
            </>
          ) : null}
          {typeof usage?.contextWindow === "number" ? (
            <>
              <dt>{labels.window}</dt>
              <dd className="tabular-nums">{formatTokenCount(usage.contextWindow)}</dd>
            </>
          ) : null}
          {typeof usage?.contextTarget === "number" ? (
            <>
              <dt>{labels.target}</dt>
              <dd className="tabular-nums">{formatTokenCount(usage.contextTarget)}</dd>
            </>
          ) : null}
          <dt>{labels.phase}</dt>
          <dd>{phaseLabel}</dd>
        </dl>
        {showCompactAffordance ? (
          <div className="mt-1 flex flex-col items-start gap-1">
            <p className="text-[0.7rem] opacity-90">{labels.compactHint}</p>
            {onInsertCompact && labels.insertCompact ? (
              <button
                type="button"
                className="text-[0.7rem] font-medium text-primary underline-offset-2 hover:underline"
                onClick={onInsertCompact}
                data-testid="context-fill-insert-compact"
              >
                {labels.insertCompact}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
