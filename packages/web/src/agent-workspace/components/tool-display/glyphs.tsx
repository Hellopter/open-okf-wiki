/**
 * Shared tool status glyph — single source for transcript tool cards and the
 * run-graph attempt dialog.
 */

import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

export type ToolStatus = "running" | "pending" | "done" | "error";

/** Status glyph; renders a spacer for idle/unknown so rows stay aligned. */
export function ToolStatusGlyph({ status }: { status?: ToolStatus }) {
  if (status === "running" || status === "pending") {
    return <Spinner className="size-3 shrink-0 text-muted-foreground" />;
  }
  if (status === "error") {
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === "done") {
    return <CheckIcon className="size-3.5 shrink-0 text-success" />;
  }
  return <span className="size-3.5 shrink-0" aria-hidden />;
}
