import { CheckIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ActivityCollapsible } from "./ActivityCollapsible";

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
 * Collapsible chain-of-thought / thinking strip.
 * Streaming: open with spin glyph + live elapsed.
 * Done: always show a summary trigger row (collapsed body by default).
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

  // Reset timer when a new thinking stream begins.
  useEffect(() => {
    if (status === "streaming") {
      startedAtRef.current = Date.now();
      frozenElapsedRef.current = null;
      setElapsedSeconds(0);
      setOpen(true);
    } else {
      // Freeze elapsed at the moment we flip to done.
      if (frozenElapsedRef.current === null) {
        const secs = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
        frozenElapsedRef.current = secs;
        setElapsedSeconds(secs);
      }
      setOpen(false);
    }
  }, [status]);

  // Tick elapsed while streaming.
  useEffect(() => {
    if (status !== "streaming") return;
    const id = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [status]);

  // Empty body while streaming still shows the live row; hide empty done rows.
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

  return (
    <div
      data-slot="thinking-disclosure"
      role="status"
      aria-live="polite"
      className={cn(
        "w-full max-w-3xl rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2",
        className,
      )}
    >
      <ActivityCollapsible
        open={open}
        onOpenChange={setOpen}
        className="w-full min-w-0"
        trigger={
          <>
            {status === "streaming" ? (
              <Loader2Icon
                className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            ) : (
              <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
              {label}
            </span>
            {displayElapsed ? (
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">
                {displayElapsed}
              </span>
            ) : null}
          </>
        }
        contentClassName="mt-2"
      >
        <div className="max-h-48 overflow-y-auto border-l-2 border-border/70 pl-3">
          {multiStep ? (
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {steps.map((step, index) => (
                <li key={`${index}-${step.slice(0, 24)}`} className="leading-relaxed">
                  {step}
                </li>
              ))}
            </ul>
          ) : text ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
              {text}
            </p>
          ) : null}
        </div>
      </ActivityCollapsible>
    </div>
  );
}
