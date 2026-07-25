/**
 * Read-only detail panel for a selected Run Graph NodeAttempt.
 */

import type { NodeAttempt } from "@okf-wiki/contract";
import { useI18n } from "../../i18n";

export type NodeAttemptInspectorProps = {
  attempt: NodeAttempt | null | undefined;
  className?: string;
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 gap-2 font-mono text-[10px] leading-relaxed">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground/90">{value}</span>
    </div>
  );
}

export function NodeAttemptInspector({ attempt, className }: NodeAttemptInspectorProps) {
  const { t } = useI18n();

  if (!attempt) {
    return (
      <p
        className={className ?? "text-[11px] text-muted-foreground"}
        data-testid="run-graph-attempt-inspector-empty"
      >
        {t.agentWorkspace.runGraphAttemptEmpty}
      </p>
    );
  }

  const items = attempt.items ?? [];

  return (
    <div
      className={className ?? "space-y-1 rounded border border-border/50 bg-background/40 p-2"}
      data-testid="run-graph-attempt-inspector"
      data-attempt-id={attempt.attemptId}
      data-node-key={attempt.nodeKey}
      data-attempt-status={attempt.status}
    >
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t.agentWorkspace.runGraphAttempt}
      </p>
      <Field label="id" value={attempt.attemptId} />
      <Field label="node" value={attempt.nodeKey} />
      {attempt.role ? <Field label="role" value={attempt.role} /> : null}
      <Field label="status" value={attempt.status} />
      {attempt.runIndex > 0 ? <Field label="round" value={`r${attempt.runIndex + 1}`} /> : null}
      {attempt.summary ? <Field label="summary" value={attempt.summary} /> : null}
      {attempt.errorClass ? <Field label="error" value={attempt.errorClass} /> : null}
      {attempt.receiptPath ? <Field label="receipt" value={attempt.receiptPath} /> : null}
      {attempt.usage?.contextTokens != null ? (
        <Field label="ctx" value={String(attempt.usage.contextTokens)} />
      ) : null}
      {attempt.usage?.turns != null ? (
        <Field label="turns" value={String(attempt.usage.turns)} />
      ) : null}
      {items.length > 0 ? (
        <ul className="mt-1 space-y-0.5 border-t border-border/40 pt-1">
          {items.slice(0, 8).map((item, index) => (
            <li
              key={`${attempt.attemptId}-item-${index}`}
              className="font-mono text-[10px] text-muted-foreground"
            >
              {item.type === "text" ? (
                <span className="line-clamp-2 whitespace-pre-wrap break-words">{item.text}</span>
              ) : (
                <span>
                  <span className="text-foreground/80">{item.name}</span>
                  {item.argsSummary ? (
                    <span className="text-muted-foreground"> {item.argsSummary}</span>
                  ) : null}
                  {item.status ? (
                    <span className="text-muted-foreground"> · {item.status}</span>
                  ) : null}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
