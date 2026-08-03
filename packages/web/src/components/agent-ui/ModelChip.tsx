import { cn } from "@/lib/utils";

export type ModelChipProps = {
  /** Provider model id (read-only display). */
  modelId: string;
  /** Accessible name. */
  ariaLabel?: string;
  className?: string;
  "data-testid"?: string;
};

/**
 * Read-only model id chip for attempt surfaces.
 * Not a switcher — model changes live on Session composer only.
 */
export function ModelChip({
  modelId,
  ariaLabel,
  className,
  "data-testid": testId = "model-chip",
}: ModelChipProps) {
  const trimmed = modelId.trim();
  if (!trimmed) return null;

  return (
    <span
      className={cn(
        "inline-flex max-w-[12rem] items-center truncate rounded-md px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        "bg-muted/50",
        className,
      )}
      title={trimmed}
      aria-label={ariaLabel ?? trimmed}
      data-testid={testId}
    >
      {trimmed}
    </span>
  );
}
