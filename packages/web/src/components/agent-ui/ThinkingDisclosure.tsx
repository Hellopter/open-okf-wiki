import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ActivityCollapsible } from "./ActivityCollapsible";

export type ThinkingDisclosureProps = {
  text: string;
  status?: "streaming" | "done";
  streamingLabel: string;
  doneLabel: string;
  className?: string;
};

/**
 * Collapsible chain-of-thought / thinking block.
 * Open while streaming; auto-collapses when done (user can re-open).
 */
export function ThinkingDisclosure({
  text,
  status = "done",
  streamingLabel,
  doneLabel,
  className,
}: ThinkingDisclosureProps) {
  const [open, setOpen] = useState(status === "streaming");

  useEffect(() => {
    setOpen(status === "streaming");
  }, [status]);

  if (!text) return null;

  const label = status === "streaming" ? streamingLabel : doneLabel;

  return (
    <div data-slot="thinking-disclosure">
      <ActivityCollapsible
        open={open}
        onOpenChange={setOpen}
        className={cn("max-w-3xl border-y border-border py-2", className)}
        trigger={
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {label}
          </span>
        }
        contentClassName="mt-2"
      >
        <div className="border-l border-border pl-3">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{text}</p>
        </div>
      </ActivityCollapsible>
    </div>
  );
}
