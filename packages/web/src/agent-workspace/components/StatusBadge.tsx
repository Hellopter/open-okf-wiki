/** Compact node-status badge shared by run-graph chips and the gate panel. */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-5 px-1.5 text-2xs font-normal", className)}>
      {status}
    </Badge>
  );
}
