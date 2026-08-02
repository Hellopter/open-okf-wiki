import { type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { formatMessage, useI18n } from "../../i18n";
import type { EditorMode, ModelFormState } from "./types";

export type ModelEditorProps = {
  editorMode: EditorMode;
  form: ModelFormState;
  setForm: Dispatch<SetStateAction<ModelFormState>>;
  isSubmitting: boolean;
  maxContextTokensError?: string | null;
  onClearMaxContextTokensError?: () => void;
  onClose: () => void;
  onSave: (event: FormEvent) => void;
};

export function ModelEditor({
  editorMode,
  form,
  setForm,
  isSubmitting,
  maxContextTokensError = null,
  onClearMaxContextTokensError,
  onClose,
  onSave,
}: ModelEditorProps) {
  const { t } = useI18n();
  const open = editorMode !== "closed";
  const maxContextInvalid = Boolean(maxContextTokensError);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-lg" data-testid="model-editor">
        <form
          className="flex h-full min-h-0 flex-col"
          onSubmit={(e) => {
            void onSave(e);
          }}
        >
          <SheetHeader>
            <SheetTitle>
              {editorMode === "edit"
                ? t.globalSettings.editorEditTitle
                : t.globalSettings.editorCreateTitle}
            </SheetTitle>
            <SheetDescription>{t.globalSettings.modelIdHint}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="model-name">{t.globalSettings.displayName}</FieldLabel>
                <Input
                  id="model-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t.globalSettings.displayNamePlaceholder}
                  required
                  maxLength={120}
                  data-testid="model-name-input"
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="model-id">{t.globalSettings.modelIdLabel}</FieldLabel>
                <Input
                  id="model-id"
                  value={form.modelId}
                  onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
                  placeholder={t.globalSettings.modelIdPlaceholder}
                  required
                  className="font-mono"
                  data-testid="model-id-input"
                />
                <FieldDescription>{t.globalSettings.modelIdHint}</FieldDescription>
              </Field>
              <Field data-invalid={maxContextInvalid || undefined}>
                <FieldLabel htmlFor="model-max-context">
                  {t.globalSettings.maxContextTokens}
                </FieldLabel>
                <Input
                  id="model-max-context"
                  type="number"
                  min={1}
                  step={1}
                  value={form.maxContextTokens}
                  onChange={(e) => {
                    onClearMaxContextTokensError?.();
                    setForm((f) => ({
                      ...f,
                      maxContextTokens: e.target.value,
                    }));
                  }}
                  placeholder={t.globalSettings.maxContextTokensPlaceholder}
                  className="max-w-xs font-mono"
                  data-testid="model-max-context"
                  aria-invalid={maxContextInvalid || undefined}
                  aria-describedby={maxContextInvalid ? "model-max-context-error" : undefined}
                  aria-errormessage="model-max-context-error"
                />
                {maxContextTokensError ? (
                  <FieldError id="model-max-context-error">{maxContextTokensError}</FieldError>
                ) : null}
                <FieldDescription>{t.globalSettings.maxContextTokensHint}</FieldDescription>
              </Field>
              {form.providerId ? (
                <p className="text-sm text-muted-foreground" data-testid="model-provider-hint">
                  {formatMessage(t.globalSettings.addingUnderProvider, {
                    id: form.providerId,
                  })}
                </p>
              ) : null}
            </FieldGroup>
          </div>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !form.name.trim() || !form.modelId.trim()}
              data-testid="model-save"
            >
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {isSubmitting
                ? t.globalSettings.saving
                : editorMode === "edit"
                  ? t.globalSettings.saveEdit
                  : t.globalSettings.saveCreate}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
