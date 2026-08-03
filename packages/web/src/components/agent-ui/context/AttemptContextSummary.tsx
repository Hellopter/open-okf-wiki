import type { AttemptMetrics, WikiRunAttempt } from "@okf-wiki/contract/wiki-runs";
import { cn } from "@/lib/utils";
import { ModelChip } from "../ModelChip";
import {
  type AttemptUsageFields,
  contextPhaseFromAttemptUsage,
  formatAttemptTokenSideNote,
  sessionUsageFromAttempt,
} from "./attempt-usage";
import { ContextFillMeter } from "./ContextFillMeter";

export type AttemptContextSummaryLabels = {
  modelAria: string;
  meterAria: string;
  /** Format `in {n}` fragment; n is already compact (e.g. `12.4k`). */
  in: string;
  out: string;
  tools: string;
};

export type AttemptContextSummaryProps = {
  attempt: Pick<WikiRunAttempt, "metrics"> | { metrics?: AttemptMetrics | null } | null;
  /** Optional NodeAttempt.usage when live progress carries window/target. */
  usage?: AttemptUsageFields | null;
  labels: AttemptContextSummaryLabels;
  /** History-row density: ring without label, smaller side note. */
  compact?: boolean;
  className?: string;
  "data-testid"?: string;
};

function applyTemplate(template: string, n: string): string {
  return template.replaceAll("{n}", n);
}

/**
 * Read-only attempt chrome: model chip + context fill + optional in/out/tools.
 * Session-only ComposerSessionChrome is not used here (no model switch / compact).
 */
export function AttemptContextSummary({
  attempt,
  usage,
  labels,
  compact = false,
  className,
  "data-testid": testId = "attempt-context-summary",
}: AttemptContextSummaryProps) {
  const metrics = attempt?.metrics ?? undefined;
  const sessionUsage = sessionUsageFromAttempt(attempt, usage);
  const phase = contextPhaseFromAttemptUsage(sessionUsage);
  const side = formatAttemptTokenSideNote(metrics, {
    in: (n) => applyTemplate(labels.in, n),
    out: (n) => applyTemplate(labels.out, n),
    tools: (n) => applyTemplate(labels.tools, n),
  });
  const modelId = metrics?.modelId?.trim() || "";

  if (!modelId && !sessionUsage && !side) return null;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5",
        compact ? "gap-1" : "gap-1.5",
        className,
      )}
      data-testid={testId}
    >
      {modelId ? (
        <ModelChip
          modelId={modelId}
          ariaLabel={labels.modelAria}
          className={compact ? "max-w-[8rem] text-[10px]" : undefined}
        />
      ) : null}
      {sessionUsage ? (
        <span aria-label={labels.meterAria} className="inline-flex items-center">
          <ContextFillMeter
            usage={sessionUsage}
            phase={phase}
            showLabel={!compact}
            className={compact ? "gap-0" : undefined}
          />
        </span>
      ) : null}
      {side ? (
        <span
          className={cn(
            "min-w-0 truncate tabular-nums text-muted-foreground",
            compact ? "text-[10px]" : "text-[11px]",
          )}
          data-testid={`${testId}-side`}
          title={side.label}
        >
          {side.label}
        </span>
      ) : null}
    </div>
  );
}
