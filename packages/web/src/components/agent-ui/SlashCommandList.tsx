import { cn } from "@/lib/utils";
import type { SlashCommandOption } from "./context/slash-commands";

export type SlashCommandListProps = {
  commands: readonly SlashCommandOption[];
  activeIndex: number;
  onSelect: (command: SlashCommandOption) => void;
  onActiveIndexChange: (index: number) => void;
  listLabel: string;
  className?: string;
  "data-testid"?: string;
};

/**
 * Floating slash-command autocomplete list for the session composer.
 */
export function SlashCommandList({
  commands,
  activeIndex,
  onSelect,
  onActiveIndexChange,
  listLabel,
  className,
  "data-testid": testId = "slash-command-list",
}: SlashCommandListProps) {
  if (commands.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label={listLabel}
      data-testid={testId}
      className={cn(
        "absolute inset-x-0 bottom-full z-20 mb-1 max-h-48 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10",
        className,
      )}
    >
      {commands.map((command, index) => {
        const active = index === activeIndex;
        return (
          <button
            key={command.name}
            type="button"
            role="option"
            aria-selected={active}
            data-testid={`${testId}-item-${command.name}`}
            className={cn(
              "flex w-full cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
              active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
            )}
            onMouseEnter={() => onActiveIndexChange(index)}
            onClick={() => onSelect(command)}
          >
            <span className="shrink-0 font-medium tabular-nums">/{command.name}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-muted-foreground">{command.description}</span>
              {command.argumentHint ? (
                <span className="mt-0.5 block truncate font-mono text-[0.7rem] text-muted-foreground/80">
                  {command.argumentHint}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
