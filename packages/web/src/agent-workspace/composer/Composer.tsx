/** One Pi prompt surface. Wiki Runs begin only when the agent calls wiki_produce. */

import { type SessionUsage, formatContextFill } from "@okf-wiki/contract";
import { SendIcon, SquareIcon } from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  getProvider,
  listOperatorCommands,
  type ModelProfilePublic,
  type OperatorCommandInfo,
} from "../../api";
import { useI18n } from "../../i18n";
import type { AgentStatus } from "../hooks/useSessionAgent";

export type ComposerProps = {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
  status: AgentStatus;
  disabled?: boolean;
  className?: string;
  /** Workspace default model profile (initial dropdown selection). */
  modelProfileId?: string;
  /** Session-scoped model switch; resolves false when the server rejects it. */
  onSetModel?: (profileId: string) => Promise<boolean>;
  /** @deprecated Durable Run controls belong to the Action Dock. */
  showStopRun?: boolean;
  /** @deprecated Durable Run controls belong to the Action Dock. */
  onStopRun?: () => void;
  /** @deprecated Run state is presented by ActiveRunSummary. */
  runBusy?: boolean;
  /** @deprecated Run state is presented by ActiveRunSummary. */
  runNeedsOperator?: boolean;
  /** @deprecated Run state is presented by ActiveRunSummary. */
  runStateLabel?: string;
  /**
   * Ephemeral session context fill (last assistant totalTokens + window).
   * Hidden when absent or unformattable — never paints 0/0 noise.
   */
  sessionUsage?: SessionUsage | null;
};

/** Menu shows only while typing the command name (`/wi`), not after a space. */
function slashQueryOf(input: string): string | null {
  const match = /^\/([a-zA-Z0-9_-]*)$/.exec(input);
  return match ? match[1]!.toLowerCase() : null;
}

export function Composer({
  input,
  onInputChange,
  onSend,
  onAbort,
  status,
  disabled = false,
  className,
  modelProfileId,
  onSetModel,
  sessionUsage = null,
}: ComposerProps) {
  const { t } = useI18n();
  const inputId = useId();
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [commands, setCommands] = useState<OperatorCommandInfo[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [modelChoice, setModelChoice] = useState<string>("");
  const [modelSwitching, setModelSwitching] = useState(false);
  // Session-only pending. Send remains available during streaming for steer.
  const isPending = status === "sending" || status === "streaming";
  const trimmed = input.trim();
  // Allow send while streaming so the operator can steer / queue follow-up.
  const canSend = !disabled && trimmed.length > 0;
  const invalid = validationMessage !== null && !canSend && !isPending;
  // Only session-level disable greys the group. During streaming we must NOT
  // set control disabled / data-disabled — that applies opacity-50 to Stop too
  // (InputGroup: has-[[data-slot=input-group-control]:disabled]:opacity-50).
  const groupDisabled = disabled;
  const contextFill = useMemo(() => formatContextFill(sessionUsage), [sessionUsage]);
  const modelItems = useMemo(
    () => models.map((model) => ({ value: model.id, label: model.name || model.modelId })),
    [models],
  );

  useEffect(() => {
    let alive = true;
    listOperatorCommands()
      .then((result) => {
        if (alive) setCommands(result.commands);
      })
      .catch(() => {
        // Autocomplete is best-effort; commands still work when typed fully.
      });
    if (onSetModel) {
      getProvider()
        .then((result) => {
          if (alive) setModels(result.provider.models ?? []);
        })
        .catch(() => {
          // Model switching is best-effort UI; chat works on the default model.
        });
    }
    return () => {
      alive = false;
    };
    // onSetModel identity is stable enough per session; fetch once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedModelId = modelChoice || modelProfileId || "";

  const changeModel = useCallback(
    async (nextProfileId: string) => {
      if (!onSetModel || !nextProfileId || nextProfileId === selectedModelId) return;
      const previous = selectedModelId;
      setModelChoice(nextProfileId);
      setModelSwitching(true);
      try {
        const ok = await onSetModel(nextProfileId);
        if (!ok) setModelChoice(previous);
      } finally {
        setModelSwitching(false);
      }
    },
    [onSetModel, selectedModelId],
  );

  const slashQuery = slashQueryOf(input);
  const menuItems = useMemo(() => {
    if (slashQuery === null || menuDismissed) return [];
    return commands.filter((command) => command.name.startsWith(slashQuery));
  }, [commands, menuDismissed, slashQuery]);
  const menuOpen = menuItems.length > 0;
  const activeIndex = Math.min(highlighted, Math.max(0, menuItems.length - 1));

  const selectCommand = useCallback(
    (command: OperatorCommandInfo) => {
      onInputChange(`/${command.name} `);
      setHighlighted(0);
    },
    [onInputChange],
  );

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (disabled) return;
      if (!trimmed) {
        setValidationMessage(t.agentWorkspace.composerRequired);
        return;
      }
      setValidationMessage(null);
      onSend();
    },
    [disabled, onSend, t.agentWorkspace.composerRequired, trimmed],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setHighlighted((index) => (index + 1) % menuItems.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setHighlighted((index) => (index - 1 + menuItems.length) % menuItems.length);
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          event.preventDefault();
          selectCommand(menuItems[activeIndex]!);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (disabled) return;
      if (!trimmed) {
        setValidationMessage(t.agentWorkspace.composerRequired);
        return;
      }
      setValidationMessage(null);
      onSend();
    },
    [
      activeIndex,
      disabled,
      menuItems,
      menuOpen,
      onSend,
      selectCommand,
      t.agentWorkspace.composerRequired,
      trimmed,
    ],
  );

  return (
    <form
      data-testid="agent-composer"
      onSubmit={submit}
      aria-busy={isPending || undefined}
      className={cn(
        "relative shrink-0 border-t border-border bg-background/95 px-3 py-2.5 md:px-4",
        className,
      )}
    >
      {menuOpen ? (
        <div
          role="listbox"
          data-testid="agent-command-menu"
          className="absolute bottom-full left-3 right-3 z-10 mb-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md md:left-4 md:right-4"
        >
          {menuItems.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-testid={`agent-command-${command.name}`}
              className={cn(
                "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(event) => {
                // mousedown keeps textarea focus; click would blur first
                event.preventDefault();
                selectCommand(command);
              }}
            >
              <span className="font-medium">/{command.name}</span>
              {command.argumentHint ? (
                <span className="text-2xs text-muted-foreground">{command.argumentHint}</span>
              ) : null}
              <span className="ml-auto truncate text-2xs text-muted-foreground">
                {command.description}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <FieldGroup className="gap-2">
        <Field data-invalid={invalid || undefined} data-disabled={groupDisabled || undefined}>
          <FieldLabel htmlFor={inputId} className="sr-only">
            {t.agentWorkspace.composerLabel}
          </FieldLabel>
          <InputGroup>
            <InputGroupTextarea
              id={inputId}
              name="message"
              data-testid="agent-composer-input"
              value={input}
              onChange={(event) => {
                onInputChange(event.target.value);
                setMenuDismissed(false);
                if (validationMessage && event.target.value.trim()) {
                  setValidationMessage(null);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder={t.agentWorkspace.placeholder}
              disabled={groupDisabled}
              required={true}
              minLength={1}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${inputId}-error` : undefined}
              rows={2}
              className="min-h-[2.75rem] resize-none text-sm"
            />
            <InputGroupAddon align="block-end" className="justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                {isPending ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="agent-abort"
                    aria-label={t.agentWorkspace.stop}
                    disabled={false}
                    className="opacity-100"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onAbort();
                    }}
                  >
                    <SquareIcon data-icon="inline-start" />
                    {t.agentWorkspace.stop}
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
            {contextFill ? (
              <span
                data-testid="agent-context-fill"
                title={t.agentWorkspace.contextFillHint}
                aria-label={`${t.agentWorkspace.contextFillLabel}: ${contextFill.label}`}
                className={cn(
                  "inline-flex max-w-[9rem] items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground tabular-nums",
                  contextFill.percent !== null &&
                    contextFill.percent >= 90 &&
                    "border-destructive/40 text-destructive",
                  contextFill.percent !== null &&
                    contextFill.percent >= 70 &&
                    contextFill.percent < 90 &&
                    "border-amber-500/40 text-amber-700 dark:text-amber-400",
                )}
              >
                {contextFill.percent !== null ? (
                  <span
                    aria-hidden
                    className="relative h-1 w-6 overflow-hidden rounded-full bg-muted-foreground/20"
                  >
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full bg-current opacity-70",
                      )}
                      style={{ width: `${Math.min(100, contextFill.percent)}%` }}
                    />
                  </span>
                ) : null}
                <span data-testid="agent-context-fill-label">{contextFill.label}</span>
              </span>
            ) : null}
                {onSetModel && models.length > 0 ? (
                  <Select
                    items={modelItems}
                    value={selectedModelId || null}
                    onValueChange={(value) => void changeModel(value ?? "")}
                    disabled={disabled || isPending || modelSwitching}
                  >
                <SelectTrigger
                  data-testid="agent-model-select"
                  aria-label={t.agentWorkspace.modelSelectLabel}
                  className="max-w-44 border-transparent text-xs text-muted-foreground shadow-none hover:border-input data-[popup-open]:border-input"
                >
                  {modelSwitching ? <Spinner className="size-3" /> : null}
                  <SelectValue placeholder={t.agentWorkspace.modelSelectPlaceholder} />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectGroup>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        {model.name || model.modelId}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
                  </Select>
                ) : null}
                <span
                  role="status"
                  aria-live="polite"
                  data-testid="agent-composer-status"
                  className={cn(
                    "text-2xs text-muted-foreground",
                    status === "error" && !isPending && "text-destructive",
                    isPending && "inline-flex items-center gap-1",
                  )}
                >
                  {isPending ? <Spinner className="size-3" /> : null}
                  {isPending
                    ? t.agentWorkspace.statusBusy
                    : status === "error"
                      ? t.agentWorkspace.statusError
                      : t.agentWorkspace.statusReady}
                </span>
                <InputGroupButton
                  type="submit"
                  size="sm"
                  variant="default"
                  data-testid="agent-send"
                  disabled={!canSend}
                  aria-disabled={!canSend}
                >
                  <SendIcon data-icon="inline-start" />
                  {t.agentWorkspace.send}
                </InputGroupButton>
              </div>
            </InputGroupAddon>
          </InputGroup>
          {invalid ? (
            <FieldError id={`${inputId}-error`} data-testid="agent-composer-error">
              {validationMessage}
            </FieldError>
          ) : null}
        </Field>
      </FieldGroup>
    </form>
  );
}
