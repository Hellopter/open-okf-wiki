import {
  FilePenLineIcon,
  FileSearchIcon,
  FileTextIcon,
  Loader2Icon,
  TerminalIcon,
  WorkflowIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolItemKind, ToolItemStatus } from "./adapters/types";

export type ToolKindIconProps = {
  kind: ToolItemKind;
  status: ToolItemStatus;
  className?: string;
};

/**
 * Kind glyph for tool chip rows. Running/pending use a spinner;
 * error tints destructive; otherwise muted kind icon.
 */
export function ToolKindIcon({ kind, status, className }: ToolKindIconProps) {
  const tone =
    status === "error"
      ? "text-destructive"
      : status === "running" || status === "pending"
        ? "text-muted-foreground"
        : "text-muted-foreground";

  if (status === "running" || status === "pending") {
    return (
      <Loader2Icon
        className={cn("size-3.5 shrink-0 animate-spin", tone, className)}
        aria-hidden
      />
    );
  }

  const shared = cn("size-3.5 shrink-0", tone, className);

  switch (kind) {
    case "read":
      return <FileTextIcon className={shared} aria-hidden />;
    case "write":
      return <FilePenLineIcon className={shared} aria-hidden />;
    case "search":
      return <FileSearchIcon className={shared} aria-hidden />;
    case "wiki_produce":
      return <WorkflowIcon className={shared} aria-hidden />;
    default:
      return <TerminalIcon className={shared} aria-hidden />;
  }
}
