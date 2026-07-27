import { type FormEvent, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type AppSettingsPublic,
  createModelProfile,
  createProvider,
  deleteProvider,
  type DoctorResponse,
  deleteModelProfile,
  getApiBase,
  getAppSettings,
  getDoctor,
  getHealth,
  getProvider,
  type HealthResponse,
  type ModelProfilePublic,
  type ProviderApiShape,
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

type EditorMode = "closed" | "create" | "edit";

/** Model editor: model-level fields only — connection lives on the provider. */
const emptyForm = {
  name: "",
  modelId: "",
  /** Empty string means unset; digits-only string when set. */
  maxContextTokens: "",
  /** Owning provider (provider-first flow). */
  providerId: "",
};

/** Provider editor: gateway connection (one provider hosts many models). */
const emptyProviderForm = {
  name: "",
  baseUrl: "",
  apiKey: "",
  apiShape: "completions" as ProviderApiShape,
  /** Provider-level User-Agent (default node for gateway WAF). */
  userAgent: "node",
  /**
   * When true, allow OpenAI `developer` role (official OpenAI).
   * Default false — third-party gateways often reject it.
   */
  supportsDeveloperRole: false,
  clearApiKey: false,
};

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
  const [form, setForm] = useState(emptyForm);
  const [providerEditorMode, setProviderEditorMode] = useState<EditorMode>("closed");
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState(emptyProviderForm);
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
    setForm({ ...emptyForm, providerId });
  }

  function closeEditor() {
    setEditorMode("closed");
    setEditingId(null);
    setForm(emptyForm);
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
                <Card data-testid="home-skills-panel">
                  <CardHeader>
                    <CardTitle>{t.globalSettings.skillsTitle}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <p className="muted small">{t.globalSettings.skillsDescription}</p>
                    {appSettings ? (
                      <>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="settings-load-home-skills">
                              {t.globalSettings.loadHomeSkills}
                            </FieldLabel>
                            <FieldDescription>
                              {t.globalSettings.loadHomeSkillsHint}
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="settings-load-home-skills"
                            checked={appSettings.loadHomeSkills}
                            disabled={skillsSaving}
                            data-testid="settings-load-home-skills"
                            onCheckedChange={(checked) => {
                              void handleToggleHomeSkills(checked);
                            }}
                          />
                        </Field>
                        <dl className="kv">
                          <div>
                            <dt>{t.globalSettings.homeSkillsPath}</dt>
                            <dd className="mono small whitespace-normal">
                              {appSettings.homeSkillsDir}
                            </dd>
                          </div>
                          <div>
                            <dt>{t.globalSettings.workspaceSkillsPath}</dt>
                            <dd className="mono small whitespace-normal">
                              {"{workspace}/"}
                              {appSettings.workspaceSkillsRelative}
                            </dd>
                          </div>
                        </dl>
                        {skillsSaving ? (
                          <p className="muted small">{t.globalSettings.skillsSaving}</p>
                        ) : null}
                      </>
                    ) : (
                      <p className="muted small">{t.globalSettings.appSettingsUnavailable}</p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="models" className="flex flex-col gap-4 outline-none">
                <Card data-testid="provider-panel">
                  <CardHeader className="row-between items-center">
                    <div className="flex flex-col gap-1">
                      <CardTitle>{t.globalSettings.modelsTitle}</CardTitle>
                      <p className="muted small max-w-2xl">{t.globalSettings.providersHint}</p>
                    </div>
                    <span className="muted small shrink-0">
                      {formatMessage(t.globalSettings.modelsCount, { n: models.length })}
                      {provider?.defaultModelProfileId
                        ? ` · ${t.globalSettings.defaultSet}`
                        : models.length > 0
                          ? ` · ${t.globalSettings.noDefault}`
                          : ""}
                    </span>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    {catalogEmpty ? (
                      <Empty className="border-0 p-6" data-testid="models-empty">
                        <EmptyHeader>
                          <EmptyTitle className="text-base">
                            {t.globalSettings.modelsEmpty}
                          </EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <div className="flex flex-col gap-4" data-testid="providers-list">
                        {providers.map((entry) => (
                          <Card
                            key={entry.id}
                            className="border-border/80"
                            data-testid="provider-card"
                            data-provider-id={entry.id}
                          >
                            <CardHeader className="row-between items-start py-3">
                              <div className="min-w-0 flex flex-col gap-0.5">
                                <CardTitle className="text-base">{entry.name}</CardTitle>
                                <p className="mono small muted truncate">{entry.baseUrl || "—"}</p>
                                <p className="small muted">
                                  {entry.apiShape}
                                  {" · "}
                                  {entry.apiKeySet
                                    ? (entry.apiKeyMasked ?? t.globalSettings.keySet)
                                    : "—"}
                                  {entry.headers?.["User-Agent"]
                                    ? ` · UA=${entry.headers["User-Agent"]}`
                                    : ""}
                                  {entry.supportsDeveloperRole
                                    ? ` · ${t.globalSettings.developerRoleOn}`
                                    : ""}
                                </p>
                              </div>
                              <div className="row-actions shrink-0">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openCreateUnderProvider(entry.id)}
                                  data-testid="provider-add-model"
                                >
                                  {t.globalSettings.addModelUnderProvider}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => openProviderEdit(entry)}
                                  data-testid="provider-edit"
                                >
                                  {t.globalSettings.edit}
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="text-destructive hover:text-destructive"
                                  onClick={() => setProviderDeleteTarget(entry)}
                                  data-testid="provider-delete"
                                >
                                  {t.globalSettings.delete}
                                </Button>
                              </div>
                            </CardHeader>
                            <CardContent className="pt-0">
                              {entry.models.length === 0 ? (
                                <p
                                  className="muted small py-2"
                                  data-testid="provider-models-empty"
                                >
                                  {t.globalSettings.providerModelsEmpty}
                                </p>
                              ) : (
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>{t.globalSettings.colName}</TableHead>
                                      <TableHead>{t.globalSettings.colModelId}</TableHead>
                                      <TableHead>{t.globalSettings.colMaxContext}</TableHead>
                                      <TableHead className="text-right">
                                        {t.globalSettings.colActions}
                                      </TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {entry.models.map((m) => {
                                      const model = models.find((x) => x.id === m.id);
                                      if (!model) return null;
                                      const isDefault =
                                        provider?.defaultModelProfileId === model.id;
                                      return (
                                        <TableRow
                                          key={model.id}
                                          data-testid="model-row"
                                          data-model-id={model.id}
                                        >
                                          <TableCell>
                                            <span className="font-medium">{model.name}</span>
                                            {isDefault ? (
                                              <Badge variant="secondary" className="ml-2">
                                                {t.globalSettings.defaultBadge}
                                              </Badge>
                                            ) : null}
                                          </TableCell>
                                          <TableCell className="mono small">
                                            {model.modelId}
                                          </TableCell>
                                          <TableCell className="mono small">
                                            {model.maxContextTokens !== undefined
                                              ? model.maxContextTokens.toLocaleString()
                                              : "—"}
                                          </TableCell>
                                          <TableCell className="actions-cell">
                                            <div className="row-actions justify-end">
                                              {!isDefault ? (
                                                <Button
                                                  type="button"
                                                  size="sm"
                                                  variant="ghost"
                                                  onClick={() => void handleSetDefault(model)}
                                                  data-testid="model-set-default"
                                                >
                                                  {t.globalSettings.setDefault}
                                                </Button>
                                              ) : null}
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() => openEdit(model)}
                                                data-testid="model-edit"
                                              >
                                                {t.globalSettings.edit}
                                              </Button>
                                              <Button
                                                type="button"
                                                size="sm"
                                                variant="destructive"
                                                disabled={deletingId === model.id}
                                                onClick={() => setDeleteTarget(model)}
                                                data-testid="model-delete"
                                              >
                                                {deletingId === model.id ? (
                                                  <Spinner data-icon="inline-start" />
                                                ) : null}
                                                {deletingId === model.id
                                                  ? t.globalSettings.deleting
                                                  : t.globalSettings.delete}
                                              </Button>
                                            </div>
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              )}
                            </CardContent>
                          </Card>
                        ))}
                        {/* Fallback flat table if providers empty but models exist */}
                        {providers.length === 0 && models.length > 0 ? (
                          <Table data-testid="models-table">
                            <TableHeader>
                              <TableRow>
                                <TableHead>{t.globalSettings.colName}</TableHead>
                                <TableHead>{t.globalSettings.colModelId}</TableHead>
                                <TableHead>{t.globalSettings.colBaseUrl}</TableHead>
                                <TableHead className="text-right">
                                  {t.globalSettings.colActions}
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {models.map((model) => (
                                <TableRow key={model.id} data-testid="model-row">
                                  <TableCell>{model.name}</TableCell>
                                  <TableCell className="mono small">{model.modelId}</TableCell>
                                  <TableCell className="mono small">{model.baseUrl}</TableCell>
                                  <TableCell className="text-right">
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      onClick={() => openEdit(model)}
                                    >
                                      {t.globalSettings.edit}
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        ) : null}
                      </div>
                    )}

                    {provider ? (
                      <p className="muted small">
                        {formatMessage(t.globalSettings.envFallback, {
                          base: provider.envFallback.openaiBaseUrlSet
                            ? t.globalSettings.envSet
                            : t.globalSettings.envUnset,
                          key: provider.envFallback.openaiApiKeySet
                            ? t.globalSettings.envSet
                            : t.globalSettings.envUnset,
                        })}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>

                {editorMode !== "closed" ? (
                  <Card data-testid="model-editor">
                    <CardHeader className="row-between items-center">
                      <CardTitle>
                        {editorMode === "create"
                          ? t.globalSettings.editorCreateTitle
                          : t.globalSettings.editorEditTitle}
                      </CardTitle>
                      <Button type="button" variant="ghost" size="sm" onClick={closeEditor}>
                        {t.common.cancel}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <form className="max-w-2xl" onSubmit={(e) => void handleSave(e)}>
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor="model-name">
                              {t.globalSettings.displayName}
                            </FieldLabel>
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
                            <FieldLabel htmlFor="model-id">
                              {t.globalSettings.modelIdLabel}
                            </FieldLabel>
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
                          <Field>
                            <FieldLabel htmlFor="model-max-context">
                              {t.globalSettings.maxContextTokens}
                            </FieldLabel>
                            <Input
                              id="model-max-context"
                              type="number"
                              min={1}
                              step={1}
                              value={form.maxContextTokens}
                              onChange={(e) =>
                                setForm((f) => ({
                                  ...f,
                                  maxContextTokens: e.target.value,
                                }))
                              }
                              placeholder={t.globalSettings.maxContextTokensPlaceholder}
                              className="font-mono max-w-xs"
                              data-testid="model-max-context"
                            />
                            <FieldDescription>
                              {t.globalSettings.maxContextTokensHint}
                            </FieldDescription>
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
                ) : null}

                {providerEditorMode !== "closed" ? (
                  <Card data-testid="provider-editor">
                    <CardHeader className="row-between items-center">
                      <CardTitle>
                        {providerEditorMode === "create"
                          ? t.globalSettings.providerCreateTitle
                          : t.globalSettings.providerEditTitle}
                      </CardTitle>
                      <Button type="button" variant="ghost" size="sm" onClick={closeProviderEditor}>
                        {t.common.cancel}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <form className="max-w-2xl" onSubmit={(e) => void handleProviderSave(e)}>
                        <FieldGroup>
                          <Field>
                            <FieldLabel htmlFor="provider-name">
                              {t.globalSettings.providerName}
                            </FieldLabel>
                            <Input
                              id="provider-name"
                              value={providerForm.name}
                              onChange={(e) =>
                                setProviderForm((f) => ({ ...f, name: e.target.value }))
                              }
                              placeholder={t.globalSettings.providerNamePlaceholder}
                              required
                              maxLength={120}
                              data-testid="provider-name-input"
                              autoFocus
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="provider-base-url">
                              {t.globalSettings.baseUrl}
                            </FieldLabel>
                            <Input
                              id="provider-base-url"
                              type="url"
                              value={providerForm.baseUrl}
                              onChange={(e) =>
                                setProviderForm((f) => ({ ...f, baseUrl: e.target.value }))
                              }
                              placeholder={t.globalSettings.baseUrlPlaceholder}
                              className="font-mono"
                              data-testid="provider-base-url"
                              autoComplete="off"
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="provider-api-key">
                              {t.globalSettings.apiKey}
                            </FieldLabel>
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
                            <FieldLabel htmlFor="provider-user-agent">
                              {t.globalSettings.userAgent}
                            </FieldLabel>
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
                              <FieldDescription>
                                {t.globalSettings.supportsDeveloperRoleHint}
                              </FieldDescription>
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
                              onClick={() => void handleTest()}
                              data-testid="provider-test"
                            >
                              {testing ? <Spinner data-icon="inline-start" /> : null}
                              {testing ? t.globalSettings.testing : t.globalSettings.testConnection}
                            </Button>
                          </div>
                          {testResult ? (
                            <div
                              className={
                                testResult.ok
                                  ? "provider-test-result ok"
                                  : "provider-test-result fail"
                              }
                              data-testid="provider-test-result"
                              role="status"
                            >
                              <Badge variant={testResult.ok ? "secondary" : "destructive"}>
                                {testResult.ok
                                  ? t.globalSettings.testOk
                                  : t.globalSettings.testFail}
                              </Badge>
                              <span className="mono small">
                                {testResult.message}
                                {testResult.latencyMs !== undefined
                                  ? ` · ${testResult.latencyMs}ms`
                                  : ""}
                              </span>
                            </div>
                          ) : null}
                        </FieldGroup>
                      </form>
                    </CardContent>
                  </Card>
                ) : null}
              </TabsContent>

              <TabsContent value="diagnostics" className="flex flex-col gap-4 outline-none">
                <Card data-testid="health-panel">
                  <CardHeader>
                    <CardTitle>{t.globalSettings.healthTitle}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <dl className="kv">
                      <div>
                        <dt>{t.globalSettings.apiBase}</dt>
                        <dd className="mono">
                          {getApiBase() || t.globalSettings.apiBaseSameOrigin}
                        </dd>
                      </div>
                      <div>
                        <dt>{t.globalSettings.health}</dt>
                        <dd>
                          {health ? (
                            <Badge
                              variant={health.ok ? "secondary" : "destructive"}
                              data-testid="health-status"
                            >
                              {health.ok
                                ? formatMessage(t.globalSettings.healthOk, {
                                    service: health.service,
                                  })
                                : t.globalSettings.healthNotOk}
                            </Badge>
                          ) : (
                            <span className="muted">{t.globalSettings.healthNotChecked}</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    <div className="form-actions">
                      <Button
                        type="button"
                        onClick={() => void handleHealthCheck()}
                        disabled={checkingHealth}
                      >
                        {checkingHealth ? <Spinner data-icon="inline-start" /> : null}
                        {checkingHealth
                          ? t.globalSettings.checking
                          : t.globalSettings.runHealthCheck}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {doctor ? (
                  <Card data-testid="doctor-panel">
                    <CardHeader>
                      <CardTitle>{t.globalSettings.doctorTitle}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      <dl className="kv kv-grid">
                        <div>
                          <dt>{t.globalSettings.status}</dt>
                          <dd>
                            <Badge
                              variant={doctor.ok ? "secondary" : "destructive"}
                              data-testid="doctor-status"
                            >
                              {doctor.ok ? t.globalSettings.statusOk : t.globalSettings.statusNotOk}
                            </Badge>
                          </dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.node}</dt>
                          <dd className="mono">{doctor.node}</dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.platform}</dt>
                          <dd className="mono">
                            {doctor.platform}/{doctor.arch}
                          </dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.git}</dt>
                          <dd>
                            {doctor.git.available ? (
                              <Badge variant="secondary">
                                {t.globalSettings.gitAvailable}
                                {doctor.git.version ? ` · ${doctor.git.version}` : ""}
                              </Badge>
                            ) : (
                              <Badge variant="destructive">{t.globalSettings.gitUnavailable}</Badge>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t.globalSettings.doctorModels}</dt>
                          <dd>
                            {doctor.provider ? (
                              <Badge
                                variant={doctor.provider.configured ? "secondary" : "outline"}
                                data-testid="doctor-provider-status"
                              >
                                {formatMessage(t.globalSettings.doctorModelsConfigured, {
                                  n: doctor.provider.modelCount ?? 0,
                                })}
                                {doctor.provider.configured
                                  ? ""
                                  : ` · ${t.globalSettings.doctorNoCredentials}`}
                              </Badge>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </dd>
                        </div>
                      </dl>
                    </CardContent>
                  </Card>
                ) : null}
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
