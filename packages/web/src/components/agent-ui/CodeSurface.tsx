import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CodeSurfaceProps = {
  value: string;
  label?: string;
  maxHeightClass?: string;
  copyable?: boolean;
  className?: string;
  "data-testid"?: string;
  copyLabel?: string;
  copiedLabel?: string;
};

/**
 * Mono payload surface for tool I/O and agent payloads.
 * Self-contained chrome (border, mono density, wrap/scroll) with optional copy.
 */
export function CodeSurface({
  value,
  label,
  maxHeightClass = "max-h-64",
  copyable = false,
  className,
  "data-testid": testId,
  copyLabel = "Copy",
  copiedLabel = "Copied",
}: CodeSurfaceProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in non-secure contexts; fail quietly.
    }
  }, [value]);

  const showHeader = Boolean(label) || copyable;

  return (
    <div className={cn("min-w-0 w-full", className)} data-slot="code-surface" data-testid={testId}>
      {showHeader ? (
        <div className="mb-1 flex items-center justify-between gap-2">
          {label ? <p className="text-xs font-medium text-muted-foreground">{label}</p> : <span />}
          {copyable ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => void onCopy()}
              aria-label={copied ? copiedLabel : copyLabel}
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {copied ? copiedLabel : copyLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      <pre
        className={cn(
          "m-0 block min-w-0 w-full max-w-full overflow-x-auto overflow-y-auto rounded-md border border-border/70 bg-muted/40 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          maxHeightClass,
        )}
      >
        {value}
      </pre>
    </div>
  );
}
