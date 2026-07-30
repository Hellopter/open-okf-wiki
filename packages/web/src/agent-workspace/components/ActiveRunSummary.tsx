import { ChevronDownIcon, ChevronUpIcon, SquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import { StatusBadge } from "./StatusBadge";

export type ActiveRunSummaryProps = {
  runId: string;
  state?: string;
  summary?: string;
  loading?: boolean;
  reconnecting?: boolean;
  graphOpen?: boolean;
  onGraphOpenChange?: (open: boolean) => void;
  onCancelRun?: () => void;
  cancelDisabled?: boolean;
  children?: ReactNode;
  className?: string;
};

/** Read-only Run chrome plus its optional, durable Run cancel command. */
export function ActiveRunSummary({
  runId,
  state,
  summary,
  loading = false,
  reconnecting = false,
  graphOpen,
  onGraphOpenChange,
  onCancelRun,
  cancelDisabled = false,
  children,
  className,
}: ActiveRunSummaryProps) {
  const { t } = useI18n();

  return (
    <section
      className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}
      data-testid="active-run-summary"
      data-run-id={runId}
      data-run-state={state}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {children}
        {state ? <StatusBadge status={state} /> : null}
        {reconnecting ? (
          <span className="text-2xs text-muted-foreground">
            {t.agentWorkspace.connectionReconnecting}
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner />
            {t.common.loading}
          </span>
        ) : (
          <p
            className="truncate text-xs text-muted-foreground"
            data-testid="active-run-summary-text"
          >
            {summary ?? t.agentWorkspace.activeRunIdle}
          </p>
        )}
      </div>

      {onCancelRun ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="agent-stop-run"
          aria-label={t.agentWorkspace.stopRun}
          disabled={cancelDisabled}
          onClick={onCancelRun}
        >
          <SquareIcon data-icon="inline-start" />
          {t.agentWorkspace.stopRun}
        </Button>
      ) : null}

      {onGraphOpenChange ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="active-run-toggle-graph"
          onClick={() => onGraphOpenChange(!graphOpen)}
        >
          {graphOpen ? (
            <>
              <ChevronUpIcon data-icon="inline-start" />
              {t.agentWorkspace.collapseGraph}
            </>
          ) : (
            <>
              <ChevronDownIcon data-icon="inline-start" />
              {t.agentWorkspace.expandGraph}
            </>
          )}
        </Button>
      ) : null}
    </section>
  );
}
