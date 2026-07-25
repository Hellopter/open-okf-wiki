/** One Pi prompt surface. Wiki Runs begin only when the agent calls wiki_produce. */

import { SendIcon, SquareIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
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
};

export function Composer({
  input,
  onInputChange,
  onSend,
  onAbort,
  status,
  disabled = false,
  className,
}: ComposerProps) {
  const { t } = useI18n();
  const inputId = useId();
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const isPending = status === "sending" || status === "streaming";
  const trimmed = input.trim();
  const canSend = !disabled && !isPending && trimmed.length > 0;
  const invalid = validationMessage !== null && !canSend && !isPending;

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (disabled || isPending) return;
      if (!trimmed) {
        setValidationMessage(t.agentWorkspace.composerRequired);
        return;
      }
      setValidationMessage(null);
      onSend();
    },
    [disabled, isPending, onSend, t.agentWorkspace.composerRequired, trimmed],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (disabled || isPending) return;
      if (!trimmed) {
        setValidationMessage(t.agentWorkspace.composerRequired);
        return;
      }
      setValidationMessage(null);
      onSend();
    },
    [disabled, isPending, onSend, t.agentWorkspace.composerRequired, trimmed],
  );

  return (
    <form
      data-testid="agent-composer"
      onSubmit={submit}
      aria-busy={isPending || undefined}
      className={cn(
        "shrink-0 border-t border-border bg-background/95 px-3 py-2.5 md:px-4",
        className,
      )}
    >
      <label htmlFor={inputId} className="sr-only">
        {t.agentWorkspace.composerLabel}
      </label>
      <InputGroup data-disabled={disabled || isPending ? true : undefined}>
        <InputGroupTextarea
          id={inputId}
          name="message"
          data-testid="agent-composer-input"
          value={input}
          onChange={(event) => {
            onInputChange(event.target.value);
            if (validationMessage && event.target.value.trim()) {
              setValidationMessage(null);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={t.agentWorkspace.placeholder}
          disabled={disabled || isPending}
          required={true}
          minLength={1}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? `${inputId}-error` : undefined}
          rows={2}
          className="min-h-[2.75rem] resize-none text-sm"
        />
        <InputGroupAddon align="block-end" className="justify-between gap-2">
          <div>
            {isPending ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="agent-abort"
                aria-label="Stop"
                onClick={onAbort}
              >
                <SquareIcon data-icon="inline-start" />
                Stop
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span
              role="status"
              aria-live="polite"
              className={cn(
                "text-[11px] text-muted-foreground",
                status === "error" && "text-destructive",
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
              disabled={isPending || !canSend}
              aria-disabled={isPending || !canSend}
            >
              {isPending ? (
                <Spinner data-icon="inline-start" className="size-3.5" />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
              {isPending ? t.agentWorkspace.statusBusy : t.agentWorkspace.send}
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {invalid ? (
        <p
          id={`${inputId}-error`}
          role="alert"
          className="mt-1.5 text-xs text-destructive"
          data-testid="agent-composer-error"
        >
          {validationMessage}
        </p>
      ) : null}
    </form>
  );
}
