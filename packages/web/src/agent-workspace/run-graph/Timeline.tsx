/**
 * Sequential attempt timeline for a Run Graph (read-only).
 */

import type { NodeAttempt, RunGraphSnapshot } from "@okf-wiki/contract";
import { useI18n } from "../../i18n";

export type RunGraphTimelineProps = {
  graph: RunGraphSnapshot;
  className?: string;
  selectedAttemptId?: string | null;
  onSelectAttempt?: (attemptId: string) => void;
};

function attemptLabel(attempt: NodeAttempt): string {
  return attempt.role ?? attempt.nodeKey;
}

export function RunGraphTimeline({
  graph,
  className,
  selectedAttemptId,
  onSelectAttempt,
}: RunGraphTimelineProps) {
  const { t } = useI18n();
  const attempts = graph.attempts;
  if (attempts.length === 0) return null;

  return (
    <div
      className={className ?? "space-y-1"}
      data-testid="run-graph-timeline"
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t.agentWorkspace.runGraphTimeline} · {attempts.length}
      </p>
      <ol className="space-y-0.5 border-l border-border/60 pl-2">
        {attempts.map((attempt) => {
          const selected = selectedAttemptId === attempt.attemptId;
          const interactive = Boolean(onSelectAttempt);
          return (
            <li key={attempt.attemptId}>
              <button
                type="button"
                className={`w-full text-left font-mono text-[10px] leading-relaxed ${
                  selected ? "text-foreground" : "text-muted-foreground"
                } ${interactive ? "cursor-pointer hover:text-foreground/90" : "cursor-default"}`}
                data-testid="run-graph-timeline-item"
                data-attempt-id={attempt.attemptId}
                data-attempt-status={attempt.status}
                data-selected={selected ? "true" : undefined}
                onClick={() => onSelectAttempt?.(attempt.attemptId)}
                disabled={!interactive}
              >
                <span className="text-foreground/90">{attemptLabel(attempt)}</span>
                {attempt.runIndex > 0 ? (
                  <span className="text-muted-foreground"> r{attempt.runIndex + 1}</span>
                ) : null}
                <span className="text-muted-foreground"> · {attempt.status}</span>
                {attempt.summary ? (
                  <span className="block truncate pl-0 text-muted-foreground">{attempt.summary}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
