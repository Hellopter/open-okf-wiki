import { formatTokenCount } from "@okf-wiki/contract/session";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ModelProfilePublic } from "../../api";

export type ModelPickerProps = {
  models: ModelProfilePublic[];
  value: string;
  onChange: (profileId: string) => void;
  defaultModelProfileId?: string;
  disabled?: boolean;
  /** Accessible name for the trigger. */
  ariaLabel: string;
  /** Native title / tooltip (e.g. why the picker is disabled while busy). */
  title?: string;
  /** Dropdown section heading. */
  menuLabel?: string;
  /** Suffix for the workspace/catalog default model. */
  defaultSuffix?: string;
  /** Empty catalog copy (also used as the settings link label when empty). */
  emptyLabel?: string;
  /** Tooltip for the empty-state settings link. */
  emptySettingsTitle?: string;
  /** `{n}` is a compact token count (e.g. `128k`). */
  maxContextLabel?: (n: string) => string;
  className?: string;
  "data-testid"?: string;
};

function shortModelLabel(
  model: ModelProfilePublic,
  defaultModelProfileId: string | undefined,
  defaultSuffix: string,
): string {
  const suffix = defaultModelProfileId === model.id ? ` ${defaultSuffix}` : "";
  return `${model.name}${suffix}`;
}

/**
 * Compact ghost model switcher for the session composer chrome.
 * Not a form Field — layout is intentionally dense for InputGroupAddon.
 */
function formatMaxContext(
  maxContextTokens: number | undefined,
  maxContextLabel?: (n: string) => string,
): string | null {
  if (typeof maxContextTokens !== "number" || maxContextTokens <= 0) return null;
  const n = formatTokenCount(maxContextTokens);
  return maxContextLabel ? maxContextLabel(n) : `${n} ctx`;
}

export function ModelPicker({
  models,
  value,
  onChange,
  defaultModelProfileId,
  disabled,
  ariaLabel,
  title,
  menuLabel,
  defaultSuffix = "(default)",
  emptyLabel,
  emptySettingsTitle,
  maxContextLabel,
  className,
  "data-testid": testId = "composer-model-picker",
}: ModelPickerProps) {
  const selected = useMemo(
    () => models.find((model) => model.id === value) ?? null,
    [models, value],
  );

  const triggerLabel = selected
    ? shortModelLabel(selected, defaultModelProfileId, defaultSuffix)
    : (emptyLabel ?? ariaLabel);

  if (models.length === 0) {
    return (
      <Link
        to="/settings"
        className={cn(
          buttonVariants({ variant: "ghost", size: "xs" }),
          "max-w-[10rem] truncate px-1.5 text-muted-foreground",
          className,
        )}
        data-testid={`${testId}-empty`}
        aria-label={emptyLabel ?? ariaLabel}
        title={emptySettingsTitle ?? title}
      >
        <span className="truncate">{emptyLabel ?? ariaLabel}</span>
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            className={cn("max-w-[12rem] gap-0.5 px-1.5 font-normal", className)}
            data-testid={testId}
            aria-label={ariaLabel}
            title={title}
          />
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48" side="top">
        {menuLabel ? <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel> : null}
        {models.map((model) => {
          const active = model.id === value;
          const contextLine = formatMaxContext(model.maxContextTokens, maxContextLabel);
          return (
            <DropdownMenuItem
              key={model.id}
              onClick={() => {
                if (model.id !== value) onChange(model.id);
              }}
              data-testid={`${testId}-option-${model.id}`}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate">
                  {shortModelLabel(model, defaultModelProfileId, defaultSuffix)}
                </span>
                <span className="truncate text-xs text-muted-foreground">{model.modelId}</span>
                {contextLine ? (
                  <span className="truncate text-xs text-muted-foreground tabular-nums">
                    {contextLine}
                  </span>
                ) : null}
              </span>
              {active ? <CheckIcon className="size-3.5 shrink-0 opacity-80" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
