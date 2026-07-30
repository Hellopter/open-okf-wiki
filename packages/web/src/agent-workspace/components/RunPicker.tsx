import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WikiRunListItem } from "../../api";
import { StatusBadge } from "./StatusBadge";

export type RunPickerProps = {
  runId: string;
  recentRuns: WikiRunListItem[];
  onSelectRun: (runId: string) => void;
  menuSide?: "top" | "bottom";
  className?: string;
};

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}...` : runId;
}

/** URL selection only. It deliberately does not own a WikiRun subscription. */
export function RunPicker({
  runId,
  recentRuns,
  onSelectRun,
  menuSide = "bottom",
  className,
}: RunPickerProps) {
  const otherRuns = recentRuns.filter((run) => run.runId !== runId).slice(0, 8);
  const triggerContents = (
    <>
      <span className="font-mono text-xs font-medium">{shortRunId(runId)}</span>
      {otherRuns.length > 0 ? <ChevronDownIcon data-icon="inline-end" /> : null}
    </>
  );

  if (otherRuns.length === 0) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className={className}
        data-testid="active-run-switcher"
        title={runId}
      >
        {triggerContents}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={className}
            data-testid="active-run-switcher"
            title={runId}
          />
        }
      >
        {triggerContents}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={menuSide} data-testid="active-run-menu">
        <DropdownMenuGroup>
          {otherRuns.map((run) => (
            <DropdownMenuItem key={run.runId} onClick={() => onSelectRun(run.runId)}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {shortRunId(run.runId)}
              </span>
              <StatusBadge status={run.state} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
