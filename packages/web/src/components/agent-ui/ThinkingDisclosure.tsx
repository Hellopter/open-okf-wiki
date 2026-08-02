import { CheckIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ThinkingDisclosureProps = {
  text: string;
  status?: "streaming" | "done";
  streamingLabel: string;
  doneLabel: string;
  /** Optional template with `{seconds}` placeholder, e.g. "{seconds}s". */
  elapsedLabel?: string;
  className?: string;
};

function formatElapsed(template: string | undefined, seconds: number): string | null {
  if (seconds <= 0) return null;
  if (!template) return `${seconds}s`;
  return template.replace(/\{seconds\}/g, String(seconds));
}

/**
 * Lightweight chain-of-thought strip (no card shell).
 * Streaming: open with spin glyph + live elapsed.
 * Done: collapsed text row by default; expand shows left-rail steps.
 */
export function ThinkingDisclosure({
  text,
  status = "done",
  streamingLabel,
  doneLabel,
  elapsedLabel,
  className,
}: ThinkingDisclosureProps) {
  const [open, setOpen] = useState(status === "streaming");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtRef = useRef<number>(Date.now());
  const frozenElapsedRef = useRef<number | null>(null);

  useEffect(() => {
    if (status === "streaming") {
      startedAtRef.current = Date.now();
      frozenElapsedRef.current = null;
      setElapsedSeconds(0);
      setOpen(true);
    } else {
      if (frozenElapsedRef.current === null) {
        const secs = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
        frozenElapsedRef.current = secs;
        setElapsedSeconds(secs);
      }
      setOpen(false);
    }
  }, [status]);

  useEffect(() => {
    if (status !== "streaming") return;
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  if (!text && status !== "streaming") return null;

  const label = status === "streaming" ? streamingLabel : doneLabel;
  const displayElapsed =
    status === "streaming"
      ? formatElapsed(elapsedLabel, elapsedSeconds)
      : formatElapsed(elapsedLabel, frozenElapsedRef.current ?? elapsedSeconds);

  const steps = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const multiStep = steps.length > 1;
  const hasBody = Boolean(text);

  return (
    <div
      data-slot="thinking-disclosure"
      role="status"
      aria-live="polite"
      className={cn("w-full max-w-3xl min-w-0", className)}
    >
      <Collapsible open={open} onOpenChange={setOpen} className="min-w-0">
        <CollapsibleTrigger
          className={cn(
            "-mx-1.5 flex w-fit max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
            "text-[12.5px] text-muted-foreground outline-none transition-colors duration-100",
            "hover:bg-muted/50 hover:text-foreground",
            "focus-visible:ring-3 focus-visible:ring-ring/50",
          )}
          disabled={!hasBody && status !== "streaming"}
        >
          {status === "streaming" ? (
            <Loader2Icon className="size-3 shrink-0 animate-spin" aria-hidden />
          ) : hasBody ? (
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 transition-transform duration-200",
                open ? "rotate-0" : "-rotate-90",
              )}
              aria-hidden
            />
          ) : (
            <CheckIcon className="size-3 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 truncate font-medium">{label}</span>
          {displayElapsed ? (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/80">
              {displayElapsed}
            </span>
          ) : null}
        </CollapsibleTrigger>

        {hasBody ? (
          <CollapsibleContent className="min-w-0 overflow-hidden">
            <div className="mt-0.5 mb-1 ml-2 max-h-48 overflow-y-auto border-l border-border py-0.5 pl-3.5">
              {multiStep ? (
                <ul className="space-y-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  {steps.map((step, index) => (
                    <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
                  ))}
                </ul>
              ) : (
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
                  {text}
                </p>
              )}
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </div>
  );
}
