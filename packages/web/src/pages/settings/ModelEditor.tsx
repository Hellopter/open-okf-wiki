import { type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatMessage, useI18n } from "../../i18n";
import type { EditorMode, ModelFormState } from "./types";

export type ModelEditorProps = {
  editorMode: Exclude<EditorMode, "closed">;
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
  const maxContextInvalid = Boolean(maxContextTokensError);

  return (
    <Card data-testid="model-editor">
      <CardHeader className="row-between items-center">
        <CardTitle>
          {editorMode === "create"
            ? t.globalSettings.editorCreateTitle
            : t.globalSettings.editorEditTitle}
        </CardTitle>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t.common.cancel}
        </Button>
      </CardHeader>
      <CardContent>
        <form className="max-w-2xl" onSubmit={(e) => void onSave(e)}>
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
                className="font-mono max-w-xs"
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
              <p className="muted small" data-testid="model-provider-hint">
                {formatMessage(t.globalSettings.addingUnderProvider, {
                  id: form.providerId,
                })}
              </p>
            ) : null}
            <div className="form-actions">
              <Button
                type="submit"
                disabled={isSubmitting || !form.name.trim() || !form.modelId.trim()}
                data-testid="model-save"
              >
                {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                {isSubmitting
                  ? t.globalSettings.saving
                  : editorMode === "create"
                    ? t.globalSettings.saveCreate
                    : t.globalSettings.saveEdit}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
