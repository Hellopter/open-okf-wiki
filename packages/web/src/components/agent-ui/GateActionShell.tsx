import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ActivityCollapsible } from "./ActivityCollapsible";

export type GateActionShellProps = {
  title: string;
  detail?: string;
  children?: ReactNode;
  actions: ReactNode;
  meta?: ReactNode;
  /** Label for the technical details collapsible. */
  technicalDetailsLabel?: string;
  className?: string;
};

/**
 * Layout-only shell for operator gate / decision panels.
 * Does not dispatch commands — parent owns action handlers.
 */
export function GateActionShell({
  title,
  detail,
  children,
  actions,
  meta,
  technicalDetailsLabel = "Technical details",
  className,
}: GateActionShellProps) {
  return (
    <section
      className={cn("min-w-0 border-y border-border bg-muted/20 px-3 py-3", className)}
      data-slot="gate-action-shell"
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      {detail ? <p className="mt-1 text-sm text-muted-foreground">{detail}</p> : null}
      {children ? <div className="mt-3 space-y-2">{children}</div> : null}
      <div className="mt-3 flex flex-wrap gap-2">{actions}</div>
      {meta ? (
        <ActivityCollapsible
          defaultOpen={false}
          className="mt-3"
          trigger={
            <span className="text-xs font-medium text-muted-foreground">
              {technicalDetailsLabel}
            </span>
          }
          contentClassName="mt-2"
        >
          {meta}
        </ActivityCollapsible>
      ) : null}
    </section>
  );
}
