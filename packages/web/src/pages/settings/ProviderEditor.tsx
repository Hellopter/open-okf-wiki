import { type Dispatch, type FormEvent, type SetStateAction } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderApiShape, ProviderTestResult } from "../../api";
import { useI18n } from "../../i18n";
import type { EditorMode, ProviderFormState } from "./types";

export type ProviderEditorProps = {
  providerEditorMode: Exclude<EditorMode, "closed">;
  providerForm: ProviderFormState;
  setProviderForm: Dispatch<SetStateAction<ProviderFormState>>;
  isSubmitting: boolean;
  testing: boolean;
  testResult: ProviderTestResult | null;
  onClose: () => void;
  onSave: (event: FormEvent) => void;
  onTest: () => void;
};

export function ProviderEditor({
  providerEditorMode,
  providerForm,
  setProviderForm,
  isSubmitting,
  testing,
  testResult,
  onClose,
  onSave,
  onTest,
}: ProviderEditorProps) {
  const { t } = useI18n();

  return (
    <Card data-testid="provider-editor">
      <CardHeader className="row-between items-center">
        <CardTitle>
          {providerEditorMode === "create"
            ? t.globalSettings.providerCreateTitle
            : t.globalSettings.providerEditTitle}
        </CardTitle>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t.common.cancel}
        </Button>
      </CardHeader>
      <CardContent>
        <form className="max-w-2xl" onSubmit={(e) => void onSave(e)}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider-name">{t.globalSettings.providerName}</FieldLabel>
              <Input
                id="provider-name"
                value={providerForm.name}
                onChange={(e) => setProviderForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t.globalSettings.providerNamePlaceholder}
                required
                maxLength={120}
                data-testid="provider-name-input"
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-base-url">{t.globalSettings.baseUrl}</FieldLabel>
              <Input
                id="provider-base-url"
                type="url"
                value={providerForm.baseUrl}
                onChange={(e) => setProviderForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder={t.globalSettings.baseUrlPlaceholder}
                className="font-mono"
                data-testid="provider-base-url"
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-key">{t.globalSettings.apiKey}</FieldLabel>
              <Input
                id="provider-api-key"
                type="password"
                value={providerForm.apiKey}
                onChange={(e) =>
                  setProviderForm((f) => ({
                    ...f,
                    apiKey: e.target.value,
                    clearApiKey: false,
                  }))
                }
                placeholder={
                  providerEditorMode === "edit"
                    ? t.globalSettings.apiKeyKeepPlaceholder
                    : t.globalSettings.apiKeyPlaceholder
                }
                className="font-mono"
                data-testid="provider-api-key"
                autoComplete="new-password"
                disabled={providerForm.clearApiKey}
              />
              {providerEditorMode === "edit" ? (
                <Field orientation="horizontal" className="mt-1">
                  <Checkbox
                    id="provider-clear-key"
                    checked={providerForm.clearApiKey}
                    onCheckedChange={(checked) =>
                      setProviderForm((f) => ({
                        ...f,
                        clearApiKey: checked === true,
                        apiKey: checked === true ? "" : f.apiKey,
                      }))
                    }
                    data-testid="provider-clear-key"
                  />
                  <FieldLabel htmlFor="provider-clear-key" className="font-normal">
                    {t.globalSettings.clearApiKey}
                  </FieldLabel>
                </Field>
              ) : null}
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{t.globalSettings.apiShape}</FieldLegend>
              <RadioGroup
                value={providerForm.apiShape}
                onValueChange={(next) => {
                  if (next === "completions" || next === "responses") {
                    setProviderForm((f) => ({
                      ...f,
                      apiShape: next as ProviderApiShape,
                    }));
                  }
                }}
                aria-label={t.globalSettings.apiShape}
                className="gap-3"
              >
                <Field orientation="horizontal">
                  <RadioGroupItem
                    value="completions"
                    id="provider-shape-completions"
                    data-testid="provider-shape-completions"
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="provider-shape-completions">
                      {t.globalSettings.shapeCompletions}
                    </FieldLabel>
                    <FieldDescription>
                      <code>POST …/v1/chat/completions</code>
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem
                    value="responses"
                    id="provider-shape-responses"
                    data-testid="provider-shape-responses"
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="provider-shape-responses">
                      {t.globalSettings.shapeResponses}
                    </FieldLabel>
                    <FieldDescription>
                      <code>POST …/v1/responses</code>
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </RadioGroup>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="provider-user-agent">{t.globalSettings.userAgent}</FieldLabel>
              <Input
                id="provider-user-agent"
                value={providerForm.userAgent}
                onChange={(e) =>
                  setProviderForm((f) => ({
                    ...f,
                    userAgent: e.target.value,
                  }))
                }
                placeholder="node"
                className="font-mono"
                data-testid="provider-user-agent"
                autoComplete="off"
              />
              <FieldDescription>{t.globalSettings.userAgentHint}</FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="provider-developer-role"
                checked={providerForm.supportsDeveloperRole}
                onCheckedChange={(checked) =>
                  setProviderForm((f) => ({
                    ...f,
                    supportsDeveloperRole: checked === true,
                  }))
                }
                data-testid="provider-developer-role"
              />
              <FieldContent>
                <FieldLabel htmlFor="provider-developer-role" className="font-normal">
                  {t.globalSettings.supportsDeveloperRole}
                </FieldLabel>
                <FieldDescription>{t.globalSettings.supportsDeveloperRoleHint}</FieldDescription>
              </FieldContent>
            </Field>
            <div className="form-actions">
              <Button
                type="submit"
                disabled={isSubmitting || !providerForm.name.trim()}
                data-testid="provider-save"
              >
                {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                {isSubmitting
                  ? t.globalSettings.saving
                  : providerEditorMode === "create"
                    ? t.globalSettings.saveCreate
                    : t.globalSettings.saveEdit}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={testing || !providerForm.baseUrl.trim()}
                onClick={() => void onTest()}
                data-testid="provider-test"
              >
                {testing ? <Spinner data-icon="inline-start" /> : null}
                {testing ? t.globalSettings.testing : t.globalSettings.testConnection}
              </Button>
            </div>
            {testResult ? (
              <div
                className={
                  testResult.ok ? "provider-test-result ok" : "provider-test-result fail"
                }
                data-testid="provider-test-result"
                role="status"
              >
                <Badge variant={testResult.ok ? "secondary" : "destructive"}>
                  {testResult.ok ? t.globalSettings.testOk : t.globalSettings.testFail}
                </Badge>
                <span className="mono small">
                  {testResult.message}
                  {testResult.latencyMs !== undefined ? ` · ${testResult.latencyMs}ms` : ""}
                </span>
              </div>
            ) : null}
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
