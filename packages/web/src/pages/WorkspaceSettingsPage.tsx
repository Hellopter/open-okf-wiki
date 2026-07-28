import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_OPERATOR_TOOLS, type OperatorToolName } from "@okf-wiki/contract";
import {
  createWorkspaceSkillFork,
  deleteWorkspace,
  getProvider,
  getWorkspace,
  getWorkspaceSkill,
  listWorkspaceSkillFiles,
  type ModelProfilePublic,
  patchWorkspace,
  readWorkspaceSkillFile,
  resetWorkspaceSkill,
  type SkillInfo,
  type WikiLanguage,
  type WorkspaceConfig,
  writeWorkspaceSkillFile,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { formatMessage, useI18n } from "../i18n";

export type SettingsSection = "general" | "skill" | "danger";

export function WorkspaceSettingsPage({ section = "general" }: { section?: SettingsSection }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { id = "" } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const rootPathHint = searchParams.get("rootPath") ?? undefined;
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMeta, setDeleteMeta] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const [name, setName] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [publicationPath, setPublicationPath] = useState("");
  const [planConfirm, setPlanConfirm] = useState(false);
  const [wikiLanguage, setWikiLanguage] = useState<WikiLanguage>("en");
  /** Empty string means unset (derive from model max context). */
  const [contextTargetTokens, setContextTargetTokens] = useState("");
  /** Per child-agent wall-clock budget (workspace.limits.requestTimeoutSeconds). */
  const [requestTimeoutSeconds, setRequestTimeoutSeconds] = useState("600");
  /** Pi settings.retry — agent-level transport retries (workspace.limits.retry). */
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [retryMaxRetries, setRetryMaxRetries] = useState("2");
  const [retryBaseDelayMs, setRetryBaseDelayMs] = useState("2000");
  const [providerMaxRetries, setProviderMaxRetries] = useState("0");
  const [providerMaxRetryDelayMs, setProviderMaxRetryDelayMs] = useState("60000");
  const [maxDomainFanOut, setMaxDomainFanOut] = useState("4");
  const [maxLeafFanOut, setMaxLeafFanOut] = useState("6");
  const [planScoutCount, setPlanScoutCount] = useState("2");
  const [reviewCouncilSize, setReviewCouncilSize] = useState("3");
  const [reviewConcurrency, setReviewConcurrency] = useState("");
  const [domainConcurrency, setDomainConcurrency] = useState("2");
  const [plannerProfileId, setPlannerProfileId] = useState("");
  const [workerProfileId, setWorkerProfileId] = useState("");
  const [writerProfileId, setWriterProfileId] = useState("");
  const [operatorTools, setOperatorTools] = useState<OperatorToolName[]>([
    ...DEFAULT_OPERATOR_TOOLS,
  ]);
  const [skill, setSkill] = useState<SkillInfo | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillFilePath, setSkillFilePath] = useState("SKILL.md");
  const [skillFileContent, setSkillFileContent] = useState("");
  const [skillFileDirty, setSkillFileDirty] = useState(false);

  const applyWorkspace = useCallback((ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => {
    setWorkspace(ws);
    setName(ws.name);
    setPublicationPath(ws.publicationPath);
    setPlanConfirm(Boolean(ws.planConfirm));
    setWikiLanguage(ws.wikiLanguage ?? "en");
    setContextTargetTokens(
      ws.limits?.contextTargetTokens !== undefined ? String(ws.limits.contextTargetTokens) : "",
    );
    setRequestTimeoutSeconds(String(ws.limits?.requestTimeoutSeconds ?? 600));
    setRetryEnabled(ws.limits?.retry?.enabled !== false);
    setRetryMaxRetries(String(ws.limits?.retry?.maxRetries ?? 2));
    setRetryBaseDelayMs(String(ws.limits?.retry?.baseDelayMs ?? 2000));
    setProviderMaxRetries(String(ws.limits?.retry?.provider?.maxRetries ?? 0));
    setProviderMaxRetryDelayMs(String(ws.limits?.retry?.provider?.maxRetryDelayMs ?? 60_000));
    setMaxDomainFanOut(String(ws.orchestration?.maxDomainFanOut ?? 4));
    setMaxLeafFanOut(String(ws.orchestration?.maxLeafFanOut ?? 6));
    setPlanScoutCount(String(ws.orchestration?.planScoutCount ?? 2));
    setReviewCouncilSize(String(ws.orchestration?.reviewCouncilSize ?? 3));
    setReviewConcurrency(
      ws.orchestration?.reviewConcurrency !== undefined
        ? String(ws.orchestration.reviewConcurrency)
        : "",
    );
    setDomainConcurrency(String(ws.orchestration?.domainConcurrency ?? 2));
    setPlannerProfileId(ws.roleModels?.planner?.profileId ?? "");
    setWorkerProfileId(ws.roleModels?.worker?.profileId ?? "");
    setWriterProfileId(ws.roleModels?.writer?.profileId ?? "");
    setOperatorTools([...(ws.operatorTools ?? DEFAULT_OPERATOR_TOOLS)] as OperatorToolName[]);

    // Prefer profileId; else match denormalized model id; else keep empty.
    if (ws.model.profileId && catalog.some((m) => m.id === ws.model.profileId)) {
      setModelProfileId(ws.model.profileId);
    } else {
      const byModelId = catalog.find((m) => m.modelId === ws.model.id);
      setModelProfileId(byModelId?.id ?? ws.model.profileId ?? "");
    }
  }, []);

  const loadSkill = useCallback(
    async (ws: WorkspaceConfig) => {
      try {
        const data = await getWorkspaceSkill(ws.id, ws.rootPath ?? rootPathHint);
        setSkill(data.skill);
        // Prefetch SKILL.md for editor when fork is active.
        if (data.skill.kind === "fork") {
          try {
            const file = await readWorkspaceSkillFile(
              ws.id,
              "SKILL.md",
              ws.rootPath ?? rootPathHint,
            );
            setSkillFilePath("SKILL.md");
            setSkillFileContent(file.file.content);
            setSkillFileDirty(false);
          } catch {
            // Editor is optional if read fails.
          }
        }
      } catch {
        setSkill(null);
      }
    },
    [rootPathHint],
  );

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [wsData, providerData] = await Promise.all([
        getWorkspace(id, rootPathHint),
        getProvider().catch(() => null),
      ]);
      const catalog = providerData?.provider.models ?? [];
      setModels(catalog);
      setDefaultModelProfileId(providerData?.provider.defaultModelProfileId);
      applyWorkspace(wsData.workspace, catalog);
      await loadSkill(wsData.workspace);
    } catch (err) {
      setError(err);
      setWorkspace(null);
      setSkill(null);
    } finally {
      setLoading(false);
    }
  }, [id, rootPathHint, applyWorkspace, loadSkill]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const contextRaw = contextTargetTokens.trim();
      let nextContextTarget: number | undefined;
      if (contextRaw !== "") {
        const parsed = Number(contextRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          setError(new Error("contextTargetTokens must be a positive integer"));
          setIsSubmitting(false);
          return;
        }
        nextContextTarget = parsed;
      }
      const timeoutRaw = requestTimeoutSeconds.trim();
      const nextTimeoutSeconds = Number(timeoutRaw);
      if (
        !Number.isFinite(nextTimeoutSeconds) ||
        nextTimeoutSeconds <= 0 ||
        nextTimeoutSeconds > 86_400
      ) {
        setError(new Error("requestTimeoutSeconds must be between 1 and 86400"));
        setIsSubmitting(false);
        return;
      }
      const nextMaxRetries = Number(retryMaxRetries.trim());
      if (!Number.isInteger(nextMaxRetries) || nextMaxRetries < 0 || nextMaxRetries > 10) {
        setError(new Error("retry.maxRetries must be an integer from 0 to 10"));
        setIsSubmitting(false);
        return;
      }
      const nextBaseDelay = Number(retryBaseDelayMs.trim());
      if (!Number.isInteger(nextBaseDelay) || nextBaseDelay < 100 || nextBaseDelay > 60_000) {
        setError(new Error("retry.baseDelayMs must be an integer from 100 to 60000"));
        setIsSubmitting(false);
        return;
      }
      const nextProviderMaxRetries = Number(providerMaxRetries.trim());
      if (
        !Number.isInteger(nextProviderMaxRetries) ||
        nextProviderMaxRetries < 0 ||
        nextProviderMaxRetries > 5
      ) {
        setError(new Error("retry.provider.maxRetries must be an integer from 0 to 5"));
        setIsSubmitting(false);
        return;
      }
      const nextProviderMaxDelay = Number(providerMaxRetryDelayMs.trim());
      if (
        !Number.isInteger(nextProviderMaxDelay) ||
        nextProviderMaxDelay < 0 ||
        nextProviderMaxDelay > 600_000
      ) {
        setError(new Error("retry.provider.maxRetryDelayMs must be an integer from 0 to 600000"));
        setIsSubmitting(false);
        return;
      }
      const baseLimits = workspace?.limits ?? { requestTimeoutSeconds: 600 };
      const { contextTargetTokens: _drop, ...limitsWithoutContext } = baseLimits;
      void _drop;
      const nextLimits = {
        ...limitsWithoutContext,
        requestTimeoutSeconds: nextTimeoutSeconds,
        ...(nextContextTarget !== undefined ? { contextTargetTokens: nextContextTarget } : {}),
        retry: {
          enabled: retryEnabled,
          maxRetries: nextMaxRetries,
          baseDelayMs: nextBaseDelay,
          provider: {
            maxRetries: nextProviderMaxRetries,
            maxRetryDelayMs: nextProviderMaxDelay,
          },
        },
      };
      const profileToRef = (profileId: string) => {
        const m = models.find((x) => x.id === profileId);
        if (!m) return undefined;
        return { id: m.modelId, profileId: m.id };
      };
      const roleModels = {
        ...(profileToRef(plannerProfileId) ? { planner: profileToRef(plannerProfileId) } : {}),
        ...(profileToRef(workerProfileId) ? { worker: profileToRef(workerProfileId) } : {}),
        ...(profileToRef(writerProfileId) ? { writer: profileToRef(writerProfileId) } : {}),
        reviewers: workspace?.roleModels?.reviewers ?? [],
      };
      const baseOrch = workspace?.orchestration;
      const council = Math.min(4, Math.max(1, Number(reviewCouncilSize) || 3));
      const reviewConcRaw = reviewConcurrency.trim();
      const reviewConc = reviewConcRaw
        ? Math.min(4, Math.max(1, Number(reviewConcRaw) || council))
        : undefined;
      const orchestration = {
        maxDepth: baseOrch?.maxDepth ?? 2,
        maxDomainFanOut: Math.max(1, Number(maxDomainFanOut) || 4),
        maxLeafFanOut: Math.max(1, Number(maxLeafFanOut) || 6),
        planScoutCount: Math.min(4, Math.max(0, Number(planScoutCount) || 0)),
        reviewCouncilSize: council,
        ...(reviewConc !== undefined ? { reviewConcurrency: reviewConc } : {}),
        domainConcurrency: Math.min(8, Math.max(1, Number(domainConcurrency) || 2)),
      };
      const result = await patchWorkspace(
        id,
        {
          name: name.trim(),
          ...(modelProfileId ? { modelProfileId } : {}),
          publicationPath: publicationPath.trim(),
          planConfirm,
          wikiLanguage,
          limits: nextLimits,
          roleModels,
          orchestration,
          operatorTools,
        },
        workspace?.rootPath ?? rootPathHint,
      );
      applyWorkspace(result.workspace, models);
      toast.success(t.settings.saved);
    } catch (err) {
      setError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  const selectedModel = models.find((m) => m.id === modelProfileId);
  const orphanModelId =
    workspace &&
    !selectedModel &&
    workspace.model.id &&
    !models.some((m) => m.modelId === workspace.model.id)
      ? workspace.model.id
      : null;
  /** 85% of model max when workspace target is blank (matches agent CONTEXT_COMPACTION_RATIO). */
  const derivedContextTarget =
    !contextTargetTokens.trim() && selectedModel?.maxContextTokens !== undefined
      ? Math.floor(selectedModel.maxContextTokens * 0.85)
      : undefined;

  async function handleDeleteWorkspace() {
    if (!id || !workspace) {
      return;
    }
    const deleteFiles = deleteMeta;
    setDeleting(true);
    setError(null);
    try {
      await deleteWorkspace(id, {
        rootPath: workspace.rootPath ?? rootPathHint,
        deleteFiles,
      });
      navigate("/workspaces");
    } catch (err) {
      setError(err);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div data-testid="settings-page" className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {t.settings.descriptionPrefix} <Link to="/settings">{t.settings.descriptionLink}</Link>
        {t.settings.descriptionSuffix}
      </p>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {loading ? (
        <LoadingState label={t.settings.loading} />
      ) : workspace ? (
        <div className="w-full max-w-3xl">
          {section === "general" ? (
            <div className="flex flex-col gap-6">
            <Card>
              <CardContent className="flex flex-col gap-6">
                <form className="max-w-xl" onSubmit={(e) => void handleSubmit(e)}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="settings-name">{t.settings.name}</FieldLabel>
                      <Input
                        id="settings-name"
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                        }}
                        required
                        maxLength={120}
                        data-testid="settings-name-input"
                      />
                    </Field>

                    <ModelSelect
                      models={models}
                      value={modelProfileId}
                      onChange={(next) => {
                        setModelProfileId(next);
                      }}
                      defaultModelProfileId={defaultModelProfileId}
                      required={models.length > 0}
                      data-testid="settings-model-select"
                    />
                    {/* Keep a stable test id for e2e that assert selection */}
                    <input
                      type="hidden"
                      data-testid="settings-model-input"
                      value={selectedModel?.modelId ?? orphanModelId ?? ""}
                      readOnly
                    />
                    {orphanModelId ? (
                      <p className="muted small" data-testid="settings-model-orphan">
                        {formatMessage(t.settings.orphanModel, { id: orphanModelId })}
                      </p>
                    ) : null}

                    <Field>
                      <FieldLabel htmlFor="settings-publication">
                        {t.settings.publicationPath}
                      </FieldLabel>
                      <Input
                        id="settings-publication"
                        type="text"
                        value={publicationPath}
                        onChange={(e) => {
                          setPublicationPath(e.target.value);
                        }}
                        placeholder="D:/src/app/wiki"
                        required
                        className="font-mono"
                      />
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="settings-wiki-language">
                        {t.settings.wikiLanguage}
                      </FieldLabel>
                      <Select
                        value={wikiLanguage}
                        onValueChange={(next) => {
                          if (next === "en" || next === "zh") {
                            setWikiLanguage(next);
                          }
                        }}
                        items={[
                          { value: "en", label: t.settings.langEn },
                          { value: "zh", label: t.settings.langZh },
                        ]}
                      >
                        <SelectTrigger
                          id="settings-wiki-language"
                          className="w-full max-w-xs"
                          data-testid="settings-wiki-language"
                          data-value={wikiLanguage}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="en">{t.settings.langEn}</SelectItem>
                            <SelectItem value="zh">{t.settings.langZh}</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <FieldDescription>{t.settings.wikiLanguageHint}</FieldDescription>
                    </Field>

                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel htmlFor="settings-plan-confirm">
                          {t.settings.planConfirm}
                        </FieldLabel>
                        <FieldDescription>{t.settings.planConfirmHint}</FieldDescription>
                      </FieldContent>
                      <Switch
                        id="settings-plan-confirm"
                        checked={planConfirm}
                        onCheckedChange={(checked) => {
                          setPlanConfirm(checked);
                        }}
                        data-testid="settings-plan-confirm"
                      />
                    </Field>

                    <Field>
                      <FieldLabel>Operator tools</FieldLabel>
                      <FieldDescription>
                        Tools available to the chat agent. File tools are read-only and cannot
                        touch product meta; bash runs unrestricted shell commands in the
                        workspace — enable it only for workspaces you fully trust.
                      </FieldDescription>
                      <div className="flex flex-wrap gap-4" data-testid="settings-operator-tools">
                        {(["read", "grep", "find", "ls", "bash"] as OperatorToolName[]).map(
                          (tool) => (
                            <label
                              key={tool}
                              className="flex items-center gap-1.5 text-sm"
                              data-testid={`settings-operator-tool-${tool}`}
                            >
                              <input
                                type="checkbox"
                                checked={operatorTools.includes(tool)}
                                onChange={(e) => {
                                  setOperatorTools((current) =>
                                    e.target.checked
                                      ? [...current, tool]
                                      : current.filter((name) => name !== tool),
                                  );
                                }}
                              />
                              <span className={tool === "bash" ? "text-destructive" : undefined}>
                                {tool}
                              </span>
                            </label>
                          ),
                        )}
                      </div>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="settings-context-target">
                        {t.settings.contextTargetTokens}
                      </FieldLabel>
                      <Input
                        id="settings-context-target"
                        type="number"
                        min={1}
                        step={1}
                        value={contextTargetTokens}
                        onChange={(e) => {
                          setContextTargetTokens(e.target.value);
                        }}
                        placeholder={t.settings.contextTargetTokensPlaceholder}
                        className="font-mono max-w-xs"
                        data-testid="settings-context-target"
                      />
                      <FieldDescription>
                        {t.settings.contextTargetTokensHint}
                        {derivedContextTarget !== undefined ? (
                          <>
                            {" "}
                            {formatMessage(t.settings.contextTargetDerived, {
                              n: derivedContextTarget.toLocaleString(),
                            })}
                          </>
                        ) : null}
                      </FieldDescription>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="settings-request-timeout">
                        {t.settings.requestTimeoutSeconds}
                      </FieldLabel>
                      <Input
                        id="settings-request-timeout"
                        type="number"
                        min={1}
                        max={86400}
                        step={1}
                        value={requestTimeoutSeconds}
                        onChange={(e) => {
                          setRequestTimeoutSeconds(e.target.value);
                        }}
                        placeholder={t.settings.requestTimeoutSecondsPlaceholder}
                        className="font-mono max-w-xs"
                        data-testid="settings-request-timeout"
                        required
                      />
                      <FieldDescription>{t.settings.requestTimeoutSecondsHint}</FieldDescription>
                    </Field>

                    <Field>
                      <FieldLabel>{t.settings.retryTitle}</FieldLabel>
                      <FieldDescription>{t.settings.retryHint}</FieldDescription>
                      <div className="mt-2 flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                          <Switch
                            id="settings-retry-enabled"
                            checked={retryEnabled}
                            onCheckedChange={setRetryEnabled}
                            data-testid="settings-retry-enabled"
                          />
                          <FieldLabel htmlFor="settings-retry-enabled" className="font-normal">
                            {t.settings.retryEnabled}
                          </FieldLabel>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          <div className="flex flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-retry-max"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.retryMaxRetries}
                            </FieldLabel>
                            <Input
                              id="settings-retry-max"
                              type="number"
                              min={0}
                              max={10}
                              value={retryMaxRetries}
                              onChange={(e) => {
                                setRetryMaxRetries(e.target.value);
                              }}
                              className="font-mono w-24"
                              data-testid="settings-retry-max"
                              disabled={!retryEnabled}
                              title={t.settings.retryMaxRetriesHint}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-retry-base-delay"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.retryBaseDelayMs}
                            </FieldLabel>
                            <Input
                              id="settings-retry-base-delay"
                              type="number"
                              min={100}
                              max={60000}
                              step={100}
                              value={retryBaseDelayMs}
                              onChange={(e) => {
                                setRetryBaseDelayMs(e.target.value);
                              }}
                              className="font-mono w-28"
                              data-testid="settings-retry-base-delay"
                              disabled={!retryEnabled}
                              title={t.settings.retryBaseDelayMsHint}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-provider-max-retries"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.providerMaxRetries}
                            </FieldLabel>
                            <Input
                              id="settings-provider-max-retries"
                              type="number"
                              min={0}
                              max={5}
                              value={providerMaxRetries}
                              onChange={(e) => {
                                setProviderMaxRetries(e.target.value);
                              }}
                              className="font-mono w-24"
                              data-testid="settings-provider-max-retries"
                              disabled={!retryEnabled}
                              title={t.settings.providerMaxRetriesHint}
                            />
                          </div>
                          <div className="flex flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-provider-max-retry-delay"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.providerMaxRetryDelayMs}
                            </FieldLabel>
                            <Input
                              id="settings-provider-max-retry-delay"
                              type="number"
                              min={0}
                              max={600000}
                              step={1000}
                              value={providerMaxRetryDelayMs}
                              onChange={(e) => {
                                setProviderMaxRetryDelayMs(e.target.value);
                              }}
                              className="font-mono w-28"
                              data-testid="settings-provider-max-retry-delay"
                              disabled={!retryEnabled}
                              title={t.settings.providerMaxRetryDelayMsHint}
                            />
                          </div>
                        </div>
                      </div>
                    </Field>

                    <Field>
                      <FieldLabel>{t.settings.orchestrationTitle}</FieldLabel>
                      <FieldDescription>{t.settings.orchestrationHint}</FieldDescription>
                      <div className="mt-2 flex flex-wrap gap-3">
                        <div className="flex flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-max-domain-fanout"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.maxDomainFanOut}
                          </FieldLabel>
                          <Input
                            id="settings-max-domain-fanout"
                            type="number"
                            min={1}
                            max={16}
                            value={maxDomainFanOut}
                            onChange={(e) => {
                              setMaxDomainFanOut(e.target.value);
                            }}
                            className="font-mono w-24"
                            data-testid="settings-max-domain-fanout"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-max-leaf-fanout"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.maxLeafFanOut}
                          </FieldLabel>
                          <Input
                            id="settings-max-leaf-fanout"
                            type="number"
                            min={1}
                            max={16}
                            value={maxLeafFanOut}
                            onChange={(e) => {
                              setMaxLeafFanOut(e.target.value);
                            }}
                            className="font-mono w-24"
                            data-testid="settings-max-leaf-fanout"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-plan-scout-count"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.planScoutCount}
                          </FieldLabel>
                          <Input
                            id="settings-plan-scout-count"
                            type="number"
                            min={0}
                            max={4}
                            value={planScoutCount}
                            onChange={(e) => {
                              setPlanScoutCount(e.target.value);
                            }}
                            className="font-mono w-24"
                            data-testid="settings-plan-scout-count"
                            title={t.settings.planScoutCountHint}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-review-council-size"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.reviewCouncilSize}
                          </FieldLabel>
                          <Input
                            id="settings-review-council-size"
                            type="number"
                            min={1}
                            max={4}
                            value={reviewCouncilSize}
                            onChange={(e) => {
                              setReviewCouncilSize(e.target.value);
                            }}
                            className="font-mono w-24"
                            data-testid="settings-review-council-size"
                            title={t.settings.reviewCouncilSizeHint}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-review-concurrency"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.reviewConcurrency}
                          </FieldLabel>
                          <Input
                            id="settings-review-concurrency"
                            type="number"
                            min={1}
                            max={4}
                            placeholder={reviewCouncilSize || "3"}
                            value={reviewConcurrency}
                            onChange={(e) => {
                              setReviewConcurrency(e.target.value);
                            }}
                            className="font-mono w-24"
                            data-testid="settings-review-concurrency"
                            title={t.settings.reviewConcurrencyHint}
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-domain-concurrency"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.domainConcurrency}
                          </FieldLabel>
                          <Input
                            id="settings-domain-concurrency"
                            type="number"
                            min={1}
                            max={8}
                            value={domainConcurrency}
                            onChange={(e) => {
                              setDomainConcurrency(e.target.value);
                            }}
                            className="font-mono w-24"
                            data-testid="settings-domain-concurrency"
                          />
                        </div>
                      </div>
                      <FieldDescription className="mt-2 text-xs">
                        {t.settings.planScoutCountHint} {t.settings.reviewCouncilSizeHint}
                      </FieldDescription>
                    </Field>

                    <Field>
                      <FieldLabel>{t.settings.roleModelsTitle}</FieldLabel>
                      <FieldDescription>{t.settings.roleModelsHint}</FieldDescription>
                      <div className="mt-2 flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            {t.settings.rolePlanner}
                          </span>
                          <ModelSelect
                            models={models}
                            value={plannerProfileId}
                            onChange={(next) => {
                              setPlannerProfileId(next);
                            }}
                            defaultModelProfileId={defaultModelProfileId}
                            data-testid="settings-role-planner"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            {t.settings.roleWorker}
                          </span>
                          <ModelSelect
                            models={models}
                            value={workerProfileId}
                            onChange={(next) => {
                              setWorkerProfileId(next);
                            }}
                            defaultModelProfileId={defaultModelProfileId}
                            data-testid="settings-role-worker"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-muted-foreground">
                            {t.settings.roleWriter}
                          </span>
                          <ModelSelect
                            models={models}
                            value={writerProfileId}
                            onChange={(next) => {
                              setWriterProfileId(next);
                            }}
                            defaultModelProfileId={defaultModelProfileId}
                            data-testid="settings-role-writer"
                          />
                        </div>
                      </div>
                    </Field>

                    <div className="form-actions">
                      <Button
                        type="submit"
                        disabled={
                          isSubmitting ||
                          !name.trim() ||
                          !publicationPath.trim() ||
                          (models.length > 0 && !modelProfileId)
                        }
                        data-testid="settings-save"
                      >
                        {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                        {isSubmitting ? t.settings.saving : t.settings.save}
                      </Button>
                    </div>
                  </FieldGroup>
                </form>
                <dl className="kv muted-block">
                  <div>
                    <dt>{t.settings.rootPath}</dt>
                    <dd className="mono">{workspace.rootPath}</dd>
                  </div>
                  <div>
                    <dt>{t.common.id}</dt>
                    <dd className="mono">{workspace.id}</dd>
                  </div>
                  <div>
                    <dt>{t.settings.selectedModelId}</dt>
                    <dd className="mono">{workspace.model.id}</dd>
                  </div>
                  {workspace.model.profileId ? (
                    <div>
                      <dt>{t.settings.modelProfile}</dt>
                      <dd className="mono">{workspace.model.profileId}</dd>
                    </div>
                  ) : null}
                </dl>
              </CardContent>
            </Card>
            </div>
          ) : null}
          {section === "skill" ? (
            <Card>
              <CardContent className="flex flex-col gap-6">
                <section className="flex flex-col gap-3" data-testid="settings-skill-panel">
                  <h2 className="text-base font-semibold">{t.settings.skillTitle}</h2>
                  <p className="muted small">{t.settings.skillDescription}</p>
                  {skill ? (
                    <dl className="kv">
                      <div>
                        <dt>{t.settings.skillKind}</dt>
                        <dd data-testid="settings-skill-kind">{skill.kind}</dd>
                      </div>
                      <div>
                        <dt>{t.settings.skillDigest}</dt>
                        <dd className="mono small" data-testid="settings-skill-digest">
                          {skill.digest.slice(0, 16)}…
                        </dd>
                      </div>
                      <div>
                        <dt>{t.settings.skillPath}</dt>
                        <dd className="mono small whitespace-normal">{skill.path}</dd>
                      </div>
                      {skill.name ? (
                        <div>
                          <dt>{t.settings.skillName}</dt>
                          <dd>{skill.name}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : (
                    <p className="muted small">{t.settings.skillUnavailable}</p>
                  )}
                  <div className="row-actions">
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={skillBusy}
                      data-testid="settings-skill-fork"
                      onClick={() => {
                        void (async () => {
                          if (!id) {
                            return;
                          }
                          setSkillBusy(true);
                          setError(null);
                          try {
                            const result = await createWorkspaceSkillFork(
                              id,
                              workspace.rootPath ?? rootPathHint,
                            );
                            applyWorkspace(result.workspace, models);
                            setSkill(result.skill);
                            const file = await readWorkspaceSkillFile(
                              id,
                              "SKILL.md",
                              result.workspace.rootPath ?? rootPathHint,
                            );
                            setSkillFilePath("SKILL.md");
                            setSkillFileContent(file.file.content);
                            setSkillFileDirty(false);
                            toast.success(t.settings.skillForked);
                          } catch (err) {
                            setError(err);
                          } finally {
                            setSkillBusy(false);
                          }
                        })();
                      }}
                    >
                      {skillBusy ? <Spinner data-icon="inline-start" /> : null}
                      {skillBusy ? t.settings.skillWorking : t.settings.skillFork}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={skillBusy || skill?.kind !== "fork"}
                      data-testid="settings-skill-reset"
                      onClick={() => {
                        void (async () => {
                          if (!id) {
                            return;
                          }
                          setSkillBusy(true);
                          setError(null);
                          try {
                            const result = await resetWorkspaceSkill(
                              id,
                              workspace.rootPath ?? rootPathHint,
                            );
                            applyWorkspace(result.workspace, models);
                            setSkill(result.skill);
                            setSkillFileContent("");
                            setSkillFileDirty(false);
                          } catch (err) {
                            setError(err);
                          } finally {
                            setSkillBusy(false);
                          }
                        })();
                      }}
                    >
                      {t.settings.skillBundled}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={skillBusy || skill?.kind !== "fork"}
                      data-testid="settings-skill-load-file"
                      onClick={() => {
                        void (async () => {
                          if (!id || !skillFilePath.trim()) {
                            return;
                          }
                          setSkillBusy(true);
                          setError(null);
                          try {
                            const file = await readWorkspaceSkillFile(
                              id,
                              skillFilePath.trim(),
                              workspace.rootPath ?? rootPathHint,
                            );
                            setSkillFileContent(file.file.content);
                            setSkillFileDirty(false);
                          } catch (err) {
                            setError(err);
                          } finally {
                            setSkillBusy(false);
                          }
                        })();
                      }}
                    >
                      {t.settings.skillLoadFile}
                    </Button>
                    <Button
                      type="button"
                      disabled={
                        skillBusy ||
                        skill?.kind !== "fork" ||
                        !skillFileDirty ||
                        !skillFilePath.trim()
                      }
                      data-testid="settings-skill-save-file"
                      onClick={() => {
                        void (async () => {
                          if (!id) {
                            return;
                          }
                          setSkillBusy(true);
                          setError(null);
                          try {
                            const result = await writeWorkspaceSkillFile(
                              id,
                              {
                                path: skillFilePath.trim(),
                                content: skillFileContent,
                              },
                              workspace.rootPath ?? rootPathHint,
                            );
                            setSkill(result.skill);
                            setSkillFileDirty(false);
                            toast.success(t.settings.skillSaved);
                          } catch (err) {
                            setError(err);
                          } finally {
                            setSkillBusy(false);
                          }
                        })();
                      }}
                    >
                      {skillBusy ? <Spinner data-icon="inline-start" /> : null}
                      {t.settings.skillSaveFile}
                    </Button>
                  </div>
                  {skill?.kind === "fork" ? (
                    <FieldGroup className="gap-2">
                      <Field>
                        <FieldLabel htmlFor="settings-skill-file-path">
                          {t.settings.skillFileLabel}
                        </FieldLabel>
                        <Input
                          id="settings-skill-file-path"
                          className="font-mono"
                          value={skillFilePath}
                          onChange={(e) => setSkillFilePath(e.target.value)}
                          data-testid="settings-skill-file-path"
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="settings-skill-file-editor">
                          {t.settings.skillFileContentLabel}
                        </FieldLabel>
                        <Textarea
                          id="settings-skill-file-editor"
                          className="min-h-48 max-w-full font-mono text-sm"
                          value={skillFileContent}
                          onChange={(e) => {
                            setSkillFileContent(e.target.value);
                            setSkillFileDirty(true);
                          }}
                          data-testid="settings-skill-file-editor"
                          spellCheck={false}
                        />
                      </Field>
                      <p className="muted small">
                        {t.settings.skillFiles}{" "}
                        <button
                          type="button"
                          className="rounded-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                          onClick={() => {
                            void (async () => {
                              if (!id) {
                                return;
                              }
                              try {
                                const listed = await listWorkspaceSkillFiles(
                                  id,
                                  "",
                                  workspace.rootPath ?? rootPathHint,
                                );
                                const firstMd = listed.entries.find(
                                  (e) => e.kind === "file" && e.path.endsWith(".md"),
                                );
                                if (firstMd) {
                                  setSkillFilePath(firstMd.path);
                                }
                              } catch (err) {
                                setError(err);
                              }
                            })();
                          }}
                        >
                          {t.settings.skillListRoot}
                        </button>
                        {skill.files.length > 0
                          ? ` · ${skill.files.slice(0, 8).join(", ")}${skill.files.length > 8 ? "…" : ""}`
                          : null}
                      </p>
                    </FieldGroup>
                  ) : null}
                </section>
              </CardContent>
            </Card>
          ) : null}
          {section === "danger" ? (
            <Card>
              <CardContent className="flex flex-col gap-6">
                <section
                  className="flex flex-col gap-3 rounded-md border border-destructive/30 p-4"
                  data-testid="settings-danger-zone"
                >
                  <h2 className="text-base font-semibold text-destructive">
                    {t.settings.dangerTitle}
                  </h2>
                  <p className="muted small">{t.settings.dangerDescription}</p>
                  <div className="form-actions">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={deleting}
                      onClick={() => {
                        setDeleteMeta(false);
                        setDeleteDialogOpen(true);
                      }}
                      data-testid="settings-delete-workspace"
                    >
                      {deleting ? <Spinner data-icon="inline-start" /> : null}
                      {deleting ? t.common.deleting : t.settings.deleteWorkspace}
                    </Button>
                  </div>
                </section>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setDeleteMeta(false);
          }
        }}
        title={t.settings.deleteConfirmTitle}
        description={
          workspace
            ? formatMessage(t.settings.deleteConfirm, {
                name: workspace.name,
              })
            : undefined
        }
        confirmLabel={deleting ? t.common.deleting : t.settings.deleteWorkspace}
        cancelLabel={t.common.cancel}
        onConfirm={() => void handleDeleteWorkspace()}
        confirmDisabled={deleting}
        data-testid="settings-delete-dialog"
        confirmTestId="settings-delete-confirm"
        metaChecked={deleteMeta}
        onMetaCheckedChange={setDeleteMeta}
        metaLabel={t.settings.deleteMeta}
        metaTestId="settings-delete-meta"
      />
    </div>
  );
}
