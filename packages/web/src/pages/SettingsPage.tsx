import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AppSettingsPublic,
  createModelProfile,
  createProvider,
  type DoctorResponse,
  deleteModelProfile,
  deleteProvider,
  getAppSettings,
  getDoctor,
  getHealth,
  getProvider,
  type HealthResponse,
  type ModelProfilePublic,
  type ProviderEntryPublic,
  type ProviderPublic,
  type ProviderTestResult,
  patchAppSettings,
  setDefaultModelProfile,
  testProvider,
  updateModelProfile,
  updateProvider,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { formatMessage, useI18n } from "../i18n";
import { AppShell } from "../shells/AppShell";
import { AppSettingsPanel } from "./settings/AppSettingsPanel";
import { DiagnosticsPanel } from "./settings/DiagnosticsPanel";
import { ModelEditor } from "./settings/ModelEditor";
import { ProviderEditor } from "./settings/ProviderEditor";
import { ProviderPanel } from "./settings/ProviderPanel";
import {
  type EditorMode,
  emptyModelForm,
  emptyProviderForm,
  type ModelFormState,
  type ProviderFormState,
} from "./settings/types";

export function SettingsPage() {
  const { t } = useI18n();
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [provider, setProvider] = useState<ProviderPublic | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettingsPublic | null>(null);
  const [skillsSaving, setSkillsSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const [editorMode, setEditorMode] = useState<EditorMode>("closed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ModelFormState>(emptyModelForm);
  const [providerEditorMode, setProviderEditorMode] = useState<EditorMode>("closed");
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(emptyProviderForm);
  const [providerDeleteTarget, setProviderDeleteTarget] = useState<ProviderEntryPublic | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProfilePublic | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
  function setStatus(message: string) {
    toast.success(message);
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [doctorData, providerData, settingsData] = await Promise.all([
        getDoctor(),
        getProvider(),
        getAppSettings(),
      ]);
      setDoctor(doctorData);
      setProvider(providerData.provider);
      setAppSettings(settingsData.settings);
    } catch (err) {
      setError(err);
      setDoctor(null);
      setProvider(null);
      setAppSettings(null);
    } finally {
      setLoading(false);
    }
  }, []);

  async function handleToggleHomeSkills(next: boolean) {
    setSkillsSaving(true);
    setError(null);
    try {
      const result = await patchAppSettings({ loadHomeSkills: next });
      setAppSettings(result.settings);
      setStatus(t.globalSettings.skillsSaved);
    } catch (err) {
      setError(err);
    } finally {
      setSkillsSaving(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function openEdit(model: ModelProfilePublic) {
    setEditorMode("edit");
    setEditingId(model.id);
    setForm({
      name: model.name,
      modelId: model.modelId,
      maxContextTokens: model.maxContextTokens !== undefined ? String(model.maxContextTokens) : "",
      providerId: model.providerId ?? "",
    });
  }

  function openCreateUnderProvider(providerId: string) {
    setEditorMode("create");
    setEditingId(null);
    setForm({ ...emptyModelForm, providerId });
  }

  function closeEditor() {
    setEditorMode("closed");
    setEditingId(null);
    setForm(emptyModelForm);
  }

  function openProviderCreate() {
    setProviderEditorMode("create");
    setEditingProviderId(null);
    setProviderForm(emptyProviderForm);
    setTestResult(null);
  }

  function openProviderEdit(entry: ProviderEntryPublic) {
    setProviderEditorMode("edit");
    setEditingProviderId(entry.id);
    setProviderForm({
      name: entry.name,
      baseUrl: entry.baseUrl,
      apiKey: "",
      apiShape: entry.apiShape,
      userAgent: entry.headers?.["User-Agent"] ?? entry.headers?.["user-agent"] ?? "node",
      supportsDeveloperRole: entry.supportsDeveloperRole === true,
      clearApiKey: false,
    });
    setTestResult(null);
  }

  function closeProviderEditor() {
    setProviderEditorMode("closed");
    setEditingProviderId(null);
    setProviderForm(emptyProviderForm);
    setTestResult(null);
  }

  async function handleHealthCheck() {
    setCheckingHealth(true);
    setError(null);
    try {
      setHealth(await getHealth());
    } catch (err) {
      setHealth(null);
      setError(err);
    } finally {
      setCheckingHealth(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setTestResult(null);
    try {
      const maxContextRaw = form.maxContextTokens.trim();
      let maxContextTokens: number | null | undefined;
      if (maxContextRaw === "") {
        // Create: omit (unset). Edit: clear stored value.
        maxContextTokens = editorMode === "edit" ? null : undefined;
      } else {
        const parsed = Number(maxContextRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          setError(new Error("maxContextTokens must be a positive integer"));
          setIsSubmitting(false);
          return;
        }
        maxContextTokens = parsed;
      }
      // Provider-first: connection fields belong to the provider entry.
      // For legacy flat models (no providerId) keep the stored connection as-is.
      const editingModel = editingId ? models.find((m) => m.id === editingId) : undefined;
      const payload = {
        name: form.name.trim(),
        modelId: form.modelId.trim(),
        ...(form.providerId.trim()
          ? { providerId: form.providerId.trim() }
          : editingModel
            ? { baseUrl: editingModel.baseUrl, apiShape: editingModel.apiShape }
            : {}),
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
      };
      const result =
        editorMode === "edit" && editingId
          ? await updateModelProfile(editingId, payload)
          : await createModelProfile(payload);
      setProvider(result.provider);
      setStatus(
        editorMode === "edit"
          ? t.globalSettings.statusModelUpdated
          : t.globalSettings.statusModelAdded,
      );
      closeEditor();
      try {
        setDoctor(await getDoctor());
      } catch {
        // non-fatal
      }
    } catch (err) {
      setError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) {
      return;
    }
    const model = deleteTarget;
    setDeletingId(model.id);
    setError(null);
    try {
      const result = await deleteModelProfile(model.id);
      setProvider(result.provider);
      if (editingId === model.id) {
        closeEditor();
      }
      setStatus(t.globalSettings.statusModelDeleted);
    } catch (err) {
      setError(err);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSetDefault(model: ModelProfilePublic) {
    setError(null);
    try {
      const result = await setDefaultModelProfile(model.id);
      setProvider(result.provider);
      setStatus(formatMessage(t.globalSettings.statusDefault, { name: model.name }));
    } catch (err) {
      setError(err);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const ua = providerForm.userAgent.trim();
      const existing = editingProviderId
        ? provider?.providers.find((p) => p.id === editingProviderId)
        : undefined;
      const existingModelId = existing?.models[0]?.id;
      const result = await testProvider({
        // Reuse a stored key via profile when editing and no new key typed.
        ...(existingModelId && !providerForm.apiKey.trim() && !providerForm.clearApiKey
          ? { modelProfileId: existingModelId }
          : {}),
        baseUrl: providerForm.baseUrl.trim() || undefined,
        apiKey: providerForm.clearApiKey ? "" : providerForm.apiKey.trim() || undefined,
        apiShape: providerForm.apiShape,
        ...(ua ? { headers: { "User-Agent": ua } } : {}),
      });
      setTestResult(result.result);
    } catch (err) {
      setError(err);
    } finally {
      setTesting(false);
    }
  }

  async function handleProviderSave(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const ua = providerForm.userAgent.trim();
      const payload = {
        name: providerForm.name.trim(),
        baseUrl: providerForm.baseUrl.trim(),
        apiShape: providerForm.apiShape,
        ...(providerForm.clearApiKey
          ? { apiKey: null }
          : providerForm.apiKey.trim()
            ? { apiKey: providerForm.apiKey.trim() }
            : {}),
        headers: ua ? { "User-Agent": ua } : null,
        supportsDeveloperRole: providerForm.supportsDeveloperRole,
      };
      const result =
        providerEditorMode === "edit" && editingProviderId
          ? await updateProvider(editingProviderId, payload)
          : await createProvider(payload);
      setProvider(result.provider);
      setStatus(
        providerEditorMode === "edit"
          ? t.globalSettings.statusProviderUpdated
          : t.globalSettings.statusProviderAdded,
      );
      closeProviderEditor();
    } catch (err) {
      setError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleProviderDeleteConfirm() {
    if (!providerDeleteTarget) return;
    const entry = providerDeleteTarget;
    setError(null);
    try {
      const result = await deleteProvider(entry.id);
      setProvider(result.provider);
      setProviderDeleteTarget(null);
      if (editingProviderId === entry.id) closeProviderEditor();
      setStatus(t.globalSettings.statusProviderDeleted);
    } catch (err) {
      setError(err);
      setProviderDeleteTarget(null);
    }
  }

  const models = provider?.models ?? [];
  const providers = provider?.providers ?? [];
  // Provider-first: an empty-model gateway must still render so operators can
  // add models under it. Only hide the list when both providers and models
  // are absent (legacy flat catalog uses models without providers).
  const catalogEmpty = providers.length === 0 && models.length === 0;

  return (
    <AppShell>
      <div data-testid="global-settings-page" className="flex flex-col gap-5">
        <header className="page-header row-between">
          <div>
            <h1>{t.globalSettings.title}</h1>
            <p>{t.globalSettings.description}</p>
          </div>
          <div className="row-actions">
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadAll()}
              disabled={loading}
            >
              {t.globalSettings.refresh}
            </Button>
            <Button
              type="button"
              onClick={openProviderCreate}
              disabled={loading || providerEditorMode !== "closed"}
              data-testid="provider-add"
            >
              {t.globalSettings.addProvider}
            </Button>
          </div>
        </header>

        <ErrorBanner error={error} onDismiss={() => setError(null)} />

        {loading ? (
          <LoadingState label={t.globalSettings.loading} />
        ) : (
          <>
            <Tabs defaultValue="models" className="w-full">
              <TabsList variant="line" className="mb-2 w-full justify-start">
                <TabsTrigger value="models" data-testid="settings-tab-models">
                  {t.globalSettings.tabModels}
                </TabsTrigger>
                <TabsTrigger value="app" data-testid="settings-tab-app">
                  {t.globalSettings.tabApp}
                </TabsTrigger>
                <TabsTrigger value="diagnostics" data-testid="settings-tab-diagnostics">
                  {t.globalSettings.tabDiagnostics}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="app" className="flex flex-col gap-4 outline-none">
                <AppSettingsPanel
                  appSettings={appSettings}
                  skillsSaving={skillsSaving}
                  onToggleHomeSkills={handleToggleHomeSkills}
                />
              </TabsContent>

              <TabsContent value="models" className="flex flex-col gap-4 outline-none">
                <ProviderPanel
                  provider={provider}
                  models={models}
                  providers={providers}
                  catalogEmpty={catalogEmpty}
                  deletingId={deletingId}
                  onAddModel={openCreateUnderProvider}
                  onEditProvider={openProviderEdit}
                  onDeleteProvider={setProviderDeleteTarget}
                  onEditModel={openEdit}
                  onDeleteModel={setDeleteTarget}
                  onSetDefault={handleSetDefault}
                />

                {editorMode !== "closed" ? (
                  <ModelEditor
                    editorMode={editorMode}
                    form={form}
                    setForm={setForm}
                    isSubmitting={isSubmitting}
                    onClose={closeEditor}
                    onSave={handleSave}
                  />
                ) : null}

                {providerEditorMode !== "closed" ? (
                  <ProviderEditor
                    providerEditorMode={providerEditorMode}
                    providerForm={providerForm}
                    setProviderForm={setProviderForm}
                    isSubmitting={isSubmitting}
                    testing={testing}
                    testResult={testResult}
                    onClose={closeProviderEditor}
                    onSave={handleProviderSave}
                    onTest={handleTest}
                  />
                ) : null}
              </TabsContent>

              <TabsContent value="diagnostics" className="flex flex-col gap-4 outline-none">
                <DiagnosticsPanel
                  health={health}
                  doctor={doctor}
                  checkingHealth={checkingHealth}
                  onHealthCheck={handleHealthCheck}
                />
              </TabsContent>
            </Tabs>

            <ConfirmDialog
              open={providerDeleteTarget != null}
              onOpenChange={(open) => {
                if (!open) setProviderDeleteTarget(null);
              }}
              title={t.globalSettings.providerDeleteConfirmTitle}
              description={
                providerDeleteTarget
                  ? formatMessage(t.globalSettings.providerDeleteConfirmBody, {
                      name: providerDeleteTarget.name,
                    })
                  : undefined
              }
              confirmLabel={t.globalSettings.deleteSubmit}
              cancelLabel={t.common.cancel}
              onConfirm={() => void handleProviderDeleteConfirm()}
              data-testid="provider-delete-dialog"
              confirmTestId="provider-delete-confirm"
            />

            <ConfirmDialog
              open={deleteTarget != null}
              onOpenChange={(open) => {
                if (!open) {
                  setDeleteTarget(null);
                }
              }}
              title={t.globalSettings.deleteConfirmTitle}
              description={
                deleteTarget
                  ? formatMessage(t.globalSettings.deleteConfirmBody, {
                      name: deleteTarget.name,
                    })
                  : undefined
              }
              confirmLabel={
                deletingId != null ? t.globalSettings.deleting : t.globalSettings.deleteSubmit
              }
              cancelLabel={t.common.cancel}
              onConfirm={() => void handleDeleteConfirm()}
              confirmDisabled={deletingId != null}
              data-testid="model-delete-dialog"
              confirmTestId="model-delete-confirm"
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
