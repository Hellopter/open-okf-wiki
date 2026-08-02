import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { StatusGlyph } from "./StatusGlyph";
import {
  type StatusDescriptor,
  type StatusKind,
  describeStatus,
} from "./status";

export type AgentTaskRowProps = {
  title: string;
  summary?: string;
  status?: string;
  kind?: StatusKind;
  descriptor?: StatusDescriptor;
  statusLabel?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** When set, render as a button (e.g. run link / attempt select). */
  onClick?: () => void;
  /** Expand chevron affordance without full collapsible chrome. */
  expandable?: boolean;
  expanded?: boolean;
  "data-testid"?: string;
};

/**
 * Dense task / attempt / run row: glyph + title + optional summary + badge.
 */
export function AgentTaskRow({
  title,
  summary,
  status,
  kind = "run",
  descriptor: descriptorProp,
  statusLabel,
  children,
  className,
  onClick,
  expandable = false,
  expanded = false,
  "data-testid": testId,
}: AgentTaskRowProps) {
  const descriptor =
    descriptorProp ?? (status ? describeStatus(kind, status) : describeStatus(kind, "queued"));

  const content = (
    <>
      <StatusGlyph descriptor={descriptor} className="size-4" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {summary ? (
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {summary}
        </span>
      ) : null}
      {statusLabel !== undefined || status ? (
        <StatusBadge descriptor={descriptor}>{statusLabel ?? status}</StatusBadge>
      ) : null}
      {expandable ? (
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      ) : null}
      {children}
    </>
  );

  const sharedClass = cn(
    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
    "hover:bg-muted/60",
    className,
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={sharedClass}
        onClick={onClick}
        data-slot="agent-task-row"
        data-testid={testId}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={sharedClass} data-slot="agent-task-row" data-testid={testId}>
      {content}
    </div>
  );
}
