import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ActivityCollapsibleProps = {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  /** Hide the chevron when the row is not expandable chrome. */
  showChevron?: boolean;
};

/**
 * Accessible collapsible row for tool traces, thinking, and technical meta.
 * Wraps shadcn/base-ui Collapsible with a rotating chevron header.
 */
export function ActivityCollapsible({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  children,
  className,
  triggerClassName,
  contentClassName,
  showChevron = true,
}: ActivityCollapsibleProps) {
  return (
    <Collapsible
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      className={cn("group/activity min-w-0", className)}
      data-slot="activity-collapsible"
    >
      <CollapsibleTrigger
        className={cn(
          "group/trigger flex w-full min-w-0 cursor-pointer items-center gap-2 text-left outline-none",
          "focus-visible:ring-3 focus-visible:ring-ring/50",
          triggerClassName,
        )}
      >
        {trigger}
        {showChevron ? (
          <ChevronRightIcon
            className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90"
            aria-hidden
          />
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("min-w-0", contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
