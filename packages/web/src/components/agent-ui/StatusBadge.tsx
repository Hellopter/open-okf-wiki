import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { describeStatus, type StatusDescriptor, type StatusKind } from "./status";

export type StatusBadgeProps = {
  /** Precomputed descriptor (preferred when the parent already mapped status). */
  descriptor?: StatusDescriptor;
  /** When descriptor is omitted, compute from kind + status. */
  kind?: StatusKind;
  status?: string;
  children?: ReactNode;
  className?: string;
};

export function StatusBadge({
  descriptor: descriptorProp,
  kind,
  status,
  children,
  className,
}: StatusBadgeProps) {
  const descriptor =
    descriptorProp ??
    (kind && status ? describeStatus(kind, status) : describeStatus("tool", status ?? ""));

  return (
    <Badge
      variant={descriptor.badgeVariant}
      className={cn("shrink-0", className)}
      data-slot="status-badge"
      data-tone={descriptor.tone}
    >
      {children}
    </Badge>
  );
}
