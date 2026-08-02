import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CodeSurface, type CodeSurfaceProps } from "./CodeSurface";

export type DiffSurfaceProps = Omit<CodeSurfaceProps, "value"> & {
  value: string;
};

function looksLikeUnifiedDiff(value: string): boolean {
  const lines = value.split("\n").slice(0, 40);
  let hits = 0;
  for (const line of lines) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("+") ||
      line.startsWith("-")
    ) {
      hits += 1;
    }
  }
  // Require a few diff markers so plain text with a leading "-" does not match.
  return hits >= 2;
}

function DiffLine({ line }: { line: string }) {
  let tone = "text-foreground";
  if (line.startsWith("+++") || line.startsWith("---")) {
    tone = "text-muted-foreground";
  } else if (line.startsWith("@@")) {
    tone = "text-info";
  } else if (line.startsWith("+")) {
    tone = "bg-success/10 text-success";
  } else if (line.startsWith("-")) {
    tone = "bg-destructive/10 text-destructive";
  }
  return (
    <div
      className={cn(
        "px-2.5 py-0 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
        tone,
      )}
    >
      {line || " "}
    </div>
  );
}

/**
 * Unified-diff aware surface; falls back to CodeSurface for plain payloads.
 */
export function DiffSurface({
  value,
  label,
  maxHeightClass = "max-h-64",
  copyable = false,
  className,
  "data-testid": testId,
  copyLabel = "Copy",
  copiedLabel = "Copied",
}: DiffSurfaceProps) {
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

  if (!looksLikeUnifiedDiff(value)) {
    return (
      <CodeSurface
        value={value}
        label={label}
        maxHeightClass={maxHeightClass}
        copyable={copyable}
        className={className}
        data-testid={testId}
        copyLabel={copyLabel}
        copiedLabel={copiedLabel}
      />
    );
  }

  const lines = value.split("\n");
  const showHeader = Boolean(label) || copyable;

  return (
    <div className={cn("min-w-0 w-full", className)} data-slot="diff-surface" data-testid={testId}>
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
      <div
        className={cn(
          "min-w-0 w-full max-w-full overflow-x-auto overflow-y-auto rounded-md border border-border/70 bg-muted/40 py-1",
          maxHeightClass,
        )}
      >
        {lines.map((line, index) => (
          <DiffLine key={`${index}-${line.slice(0, 24)}`} line={line} />
        ))}
      </div>
    </div>
  );
}
