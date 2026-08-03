import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ComposerSessionChromeProps = {
  /** Left cluster: model picker + context fill meter. */
  leading?: ReactNode;
  /** Right cluster: send / stop. */
  trailing?: ReactNode;
  className?: string;
  "data-testid"?: string;
};

/**
 * Composer footer chrome layout:
 * `[ Model ▾ ] [ ◎ 12.4k/128k ]  ……  [ Send ] [ Stop ]`
 */
export function ComposerSessionChrome({
  leading,
  trailing,
  className,
  "data-testid": testId = "composer-session-chrome",
}: ComposerSessionChromeProps) {
  return (
    <div
      className={cn("flex w-full items-center gap-1", className)}
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">{leading}</div>
      <div className="ml-auto flex shrink-0 items-center gap-1">{trailing}</div>
    </div>
  );
}
