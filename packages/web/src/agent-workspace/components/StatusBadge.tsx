/** Compact node-status badge shared by run-graph chips and the gate panel. */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";

function labelForStatus(status: string, t: ReturnType<typeof useI18n>["t"]): string {
  switch (status) {
    case "queued":
      return t.runStatus.queued;
    case "running":
      return t.runStatus.running;
    case "waiting_for_operator":
      return t.runStatus.waiting_for_operator;
    case "cancelling":
      return t.runStatus.cancelling;
    case "published":
      return t.runStatus.published;
    case "failed":
    case "error":
      return t.runStatus.failed;
    case "cancelled":
      return t.runStatus.cancelled;
    case "done":
      return t.runStatus.completed;
    case "awaiting":
      return t.runStatus.awaiting;
    case "pending":
      return t.runStatus.pending;
    case "idle":
      return t.runStatus.idle;
    case "skipped":
      return t.runStatus.skipped;
    case "open":
      return t.runStatus.open;
    case "resolved":
      return t.runStatus.resolved;
    case "withdrawn":
      return t.runStatus.withdrawn;
    default:
      return status.replaceAll("_", " ");
  }
}

function variantForStatus(status: string): "destructive" | "outline" | "secondary" {
  if (status === "failed" || status === "error" || status === "cancelled") return "destructive";
  if (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_operator" ||
    status === "cancelling" ||
    status === "awaiting" ||
    status === "open"
  ) {
    return "secondary";
  }
  return "outline";
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useI18n();
  return (
    <Badge
      variant={variantForStatus(status)}
      className={cn("h-5 px-1.5 text-2xs font-normal", className)}
      title={status}
    >
      {labelForStatus(status, t)}
    </Badge>
  );
}
