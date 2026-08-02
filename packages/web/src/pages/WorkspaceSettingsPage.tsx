import { DEFAULT_ORCHESTRATION } from "@okf-wiki/contract";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  deleteWorkspace,
  getProvider,
  getWorkspaceSkill,
  type ModelProfilePublic,
  patchWorkspace,
  readWorkspaceSkillFile,
  type SkillInfo,
  type WikiLanguage,
  type WorkspaceConfig,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { formatMessage, useI18n } from "../i18n";
import { notifyError, notifySuccess } from "../lib/notify";
import { DangerSection } from "./workspace-settings/DangerSection";
import {
  type GeneralFieldErrorKey,
  GeneralSection,
} from "./workspace-settings/GeneralSection";
import { SkillSection } from "./workspace-settings/SkillSection";

export type SettingsSection = "general" | "skill" | "danger";

export type WorkspaceSettingsPageProps = {
  workspace: WorkspaceConfig;
  onWorkspaceChange: (workspace: WorkspaceConfig) => void;
  section?: SettingsSection;
};

export function WorkspaceSettingsPage({
  workspace,
  onWorkspaceChange,
  section = "general",
}: WorkspaceSettingsPageProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { id = "" } = useParams<{ id: string }>();
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<GeneralFieldErrorKey, string>>>(
    {},
  );
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
  /** Open plan/publication gate auto-deny budget (0 = disabled). */
  const [gateTimeoutSeconds, setGateTimeoutSeconds] = useState("0");
  /** Pi settings.retry — agent-level transport retries (workspace.limits.retry). */
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [retryMaxRetries, setRetryMaxRetries] = useState("2");
  const [retryBaseDelayMs, setRetryBaseDelayMs] = useState("2000");
  const [providerMaxRetries, setProviderMaxRetries] = useState("0");
  const [providerMaxRetryDelayMs, setProviderMaxRetryDelayMs] = useState("60000");
  const [maxDomainFanOut, setMaxDomainFanOut] = useState("4");
  const [maxLeafFanOut, setMaxLeafFanOut] = useState("6");
  const [maxActiveRuns, setMaxActiveRuns] = useState("2");
  const [maxConcurrentAttempts, setMaxConcurrentAttempts] = useState("4");
  const [planScoutCount, setPlanScoutCount] = useState(
    String(DEFAULT_ORCHESTRATION.planScoutCount),
  );
  const [reviewCouncilSize, setReviewCouncilSize] = useState(
    String(DEFAULT_ORCHESTRATION.reviewCouncilSize),
  );
  const [reviewConcurrency, setReviewConcurrency] = useState("");
  const [domainConcurrency, setDomainConcurrency] = useState("2");
  const [leafConcurrency, setLeafConcurrency] = useState("2");
  const [plannerProfileId, setPlannerProfileId] = useState("");
  const [workerProfileId, setWorkerProfileId] = useState("");
  const [writerProfileId, setWriterProfileId] = useState("");
  const [skill, setSkill] = useState<SkillInfo | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillFilePath, setSkillFilePath] = useState("SKILL.md");
  const [skillFileContent, setSkillFileContent] = useState("");
  const [skillFileDirty, setSkillFileDirty] = useState(false);
  const skipWorkspaceReloadRef = useRef<string | null>(null);

  const clearFieldError = useCallback((key: GeneralFieldErrorKey) => {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const applyWorkspace = useCallback(
    (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => {
      onWorkspaceChange(ws);
      setName(ws.name);
      setPublicationPath(ws.publicationPath);
      setPlanConfirm(Boolean(ws.planConfirm));
      setWikiLanguage(ws.wikiLanguage ?? "en");
      setContextTargetTokens(
        ws.limits?.contextTargetTokens !== undefined ? String(ws.limits.contextTargetTokens) : "",
      );
      setRequestTimeoutSeconds(String(ws.limits?.requestTimeoutSeconds ?? 600));
      setGateTimeoutSeconds(String(ws.limits?.gateTimeoutSeconds ?? 0));
      setRetryEnabled(ws.limits?.retry?.enabled !== false);
      setRetryMaxRetries(String(ws.limits?.retry?.maxRetries ?? 2));
      setRetryBaseDelayMs(String(ws.limits?.retry?.baseDelayMs ?? 2000));
      setProviderMaxRetries(String(ws.limits?.retry?.provider?.maxRetries ?? 0));
      setProviderMaxRetryDelayMs(String(ws.limits?.retry?.provider?.maxRetryDelayMs ?? 60_000));
      setMaxDomainFanOut(String(ws.orchestration?.maxDomainFanOut ?? 4));
      setMaxLeafFanOut(String(ws.orchestration?.maxLeafFanOut ?? 6));
      setMaxActiveRuns(String(ws.orchestration.maxActiveRuns));
      setMaxConcurrentAttempts(String(ws.orchestration.maxConcurrentAttempts));
      setPlanScoutCount(
        String(ws.orchestration?.planScoutCount ?? DEFAULT_ORCHESTRATION.planScoutCount),
      );
      setReviewCouncilSize(
        String(ws.orchestration?.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize),
      );
      setReviewConcurrency(
        ws.orchestration?.reviewConcurrency !== undefined
          ? String(ws.orchestration.reviewConcurrency)
          : "",
      );
      setDomainConcurrency(String(ws.orchestration?.domainConcurrency ?? 2));
      setLeafConcurrency(String(ws.orchestration?.leafConcurrency ?? 2));
      setPlannerProfileId(ws.roleModels?.planner?.profileId ?? "");
      setWorkerProfileId(ws.roleModels?.worker?.profileId ?? "");
      setWriterProfileId(ws.roleModels?.writer?.profileId ?? "");

      // Prefer profileId; else match denormalized model id; else keep empty.
      if (ws.model.profileId && catalog.some((m) => m.id === ws.model.profileId)) {
        setModelProfileId(ws.model.profileId);
      } else {
        const byModelId = catalog.find((m) => m.modelId === ws.model.id);
        setModelProfileId(byModelId?.id ?? ws.model.profileId ?? "");
      }
    },
    [onWorkspaceChange],
  );

  const loadSkill = useCallback(async (ws: WorkspaceConfig) => {
    try {
      const data = await getWorkspaceSkill(ws.id);
      setSkill(data.skill);
      // Prefetch SKILL.md for editor when fork is active.
      if (data.skill.kind === "fork") {
        try {
          const file = await readWorkspaceSkillFile(ws.id, "SKILL.md");
          setSkillFilePath("SKILL.md");
          setSkillFileContent(file.file.content);
          setSkillFileDirty(false);
        } catch {
          // Editor is optional if read fails.
        }
      }
    } catch (err) {
      setSkill(null);
      throw err;
    }
  }, []);

  useEffect(() => {
    if (skipWorkspaceReloadRef.current === workspace.id) {
      skipWorkspaceReloadRef.current = null;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const providerData = await getProvider().catch(() => null);
        const catalog = providerData?.provider.models ?? [];
        if (cancelled) return;
        setModels(catalog);
        setDefaultModelProfileId(providerData?.provider.defaultModelProfileId);
        applyWorkspace(workspace, catalog);
        await loadSkill(workspace);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err);
          setSkill(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, applyWorkspace, loadSkill]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id) {
      return;
    }
    setIsSubmitting(true);
    const nextFieldErrors: Partial<Record<GeneralFieldErrorKey, string>> = {};
    try {
      const contextRaw = contextTargetTokens.trim();
      let nextContextTarget: number | undefined;
      if (contextRaw !== "") {
        const parsed = Number(contextRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          nextFieldErrors.contextTargetTokens = t.validation.contextTargetTokens;
        } else {
          nextContextTarget = parsed;
        }
      }
      const timeoutRaw = requestTimeoutSeconds.trim();
      const nextTimeoutSeconds = Number(timeoutRaw);
      if (
        !Number.isFinite(nextTimeoutSeconds) ||
        nextTimeoutSeconds <= 0 ||
        nextTimeoutSeconds > 86_400
      ) {
        nextFieldErrors.requestTimeoutSeconds = t.validation.requestTimeoutSeconds;
      }
      const nextMaxRetries = Number(retryMaxRetries.trim());
      if (!Number.isInteger(nextMaxRetries) || nextMaxRetries < 0 || nextMaxRetries > 10) {
        nextFieldErrors.retryMaxRetries = t.validation.retryMaxRetries;
      }
      const nextBaseDelay = Number(retryBaseDelayMs.trim());
      if (!Number.isInteger(nextBaseDelay) || nextBaseDelay < 100 || nextBaseDelay > 60_000) {
        nextFieldErrors.retryBaseDelayMs = t.validation.retryBaseDelayMs;
      }
      const nextProviderMaxRetries = Number(providerMaxRetries.trim());
      if (
        !Number.isInteger(nextProviderMaxRetries) ||
        nextProviderMaxRetries < 0 ||
        nextProviderMaxRetries > 5
      ) {
        nextFieldErrors.providerMaxRetries = t.validation.providerMaxRetries;
      }
      const nextProviderMaxDelay = Number(providerMaxRetryDelayMs.trim());
      if (
        !Number.isInteger(nextProviderMaxDelay) ||
        nextProviderMaxDelay < 0 ||
        nextProviderMaxDelay > 600_000
      ) {
        nextFieldErrors.providerMaxRetryDelayMs = t.validation.providerMaxRetryDelayMs;
      }
      const nextGateTimeout = Number(gateTimeoutSeconds.trim() || "0");
      if (!Number.isInteger(nextGateTimeout) || nextGateTimeout < 0 || nextGateTimeout > 604_800) {
        nextFieldErrors.gateTimeoutSeconds = t.validation.gateTimeoutSeconds;
      }

      if (Object.keys(nextFieldErrors).length > 0) {
        setFieldErrors(nextFieldErrors);
        setIsSubmitting(false);
        return;
      }
      setFieldErrors({});

      const baseLimits = workspace?.limits ?? { requestTimeoutSeconds: 600 };
      // Spread through an explicit optional so the fallback `{ requestTimeoutSeconds }`
      // is still destructurable under WorkspaceLimits | bare-timeout union.
      const { contextTargetTokens: _drop, ...limitsWithoutContext } = {
        contextTargetTokens: undefined as number | undefined,
        ...baseLimits,
      };
      void _drop;
      const nextLimits = {
        ...limitsWithoutContext,
        requestTimeoutSeconds: nextTimeoutSeconds,
        gateTimeoutSeconds: nextGateTimeout,
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
      const council = Math.min(
        4,
        Math.max(1, Number(reviewCouncilSize) || DEFAULT_ORCHESTRATION.reviewCouncilSize),
      );
      const reviewConcRaw = reviewConcurrency.trim();
      const reviewConc = reviewConcRaw
        ? Math.min(4, Math.max(1, Number(reviewConcRaw) || council))
        : undefined;
      const orchestration = {
        maxActiveRuns: Math.min(32, Math.max(1, Number(maxActiveRuns) || 1)),
        maxConcurrentAttempts: Math.min(128, Math.max(1, Number(maxConcurrentAttempts) || 1)),
        maxDomainFanOut: Math.max(1, Number(maxDomainFanOut) || 4),
        maxLeafFanOut: Math.max(1, Number(maxLeafFanOut) || 6),
        planScoutCount: Math.min(4, Math.max(0, Number(planScoutCount) || 0)),
        reviewCouncilSize: council,
        ...(reviewConc !== undefined ? { reviewConcurrency: reviewConc } : {}),
        domainConcurrency: Math.min(8, Math.max(1, Number(domainConcurrency) || 2)),
        leafConcurrency: Math.min(16, Math.max(1, Number(leafConcurrency) || 2)),
      };
      const result = await patchWorkspace(id, {
        name: name.trim(),
        ...(modelProfileId ? { modelProfileId } : {}),
        publicationPath: publicationPath.trim(),
        planConfirm,
        wikiLanguage,
        limits: nextLimits,
        roleModels,
        orchestration,
      });
      skipWorkspaceReloadRef.current = result.workspace.id;
      applyWorkspace(result.workspace, models);
      notifySuccess(t.settings.saved);
    } catch (err) {
      notifyError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteWorkspace() {
    if (!id || !workspace) {
      return;
    }
    const deleteFiles = deleteMeta;
    setDeleting(true);
    try {
      await deleteWorkspace(id, {
        deleteFiles,
      });
      navigate("/workspaces");
    } catch (err) {
      notifyError(err);
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
      <ErrorBanner error={loadError} onDismiss={() => setLoadError(null)} />
      {loading ? (
        <LoadingState label={t.settings.loading} />
      ) : workspace ? (
        <div className="w-full max-w-3xl">
          {section === "general" ? (
            <GeneralSection
              workspace={workspace}
              models={models}
              defaultModelProfileId={defaultModelProfileId}
              isSubmitting={isSubmitting}
              onSubmit={handleSubmit}
              fieldErrors={fieldErrors}
              onClearFieldError={clearFieldError}
              name={name}
              setName={setName}
              modelProfileId={modelProfileId}
              setModelProfileId={setModelProfileId}
              publicationPath={publicationPath}
              setPublicationPath={setPublicationPath}
              planConfirm={planConfirm}
              setPlanConfirm={setPlanConfirm}
              wikiLanguage={wikiLanguage}
              setWikiLanguage={setWikiLanguage}
              contextTargetTokens={contextTargetTokens}
              setContextTargetTokens={setContextTargetTokens}
              requestTimeoutSeconds={requestTimeoutSeconds}
              setRequestTimeoutSeconds={setRequestTimeoutSeconds}
              gateTimeoutSeconds={gateTimeoutSeconds}
              setGateTimeoutSeconds={setGateTimeoutSeconds}
              retryEnabled={retryEnabled}
              setRetryEnabled={setRetryEnabled}
              retryMaxRetries={retryMaxRetries}
              setRetryMaxRetries={setRetryMaxRetries}
              retryBaseDelayMs={retryBaseDelayMs}
              setRetryBaseDelayMs={setRetryBaseDelayMs}
              providerMaxRetries={providerMaxRetries}
              setProviderMaxRetries={setProviderMaxRetries}
              providerMaxRetryDelayMs={providerMaxRetryDelayMs}
              setProviderMaxRetryDelayMs={setProviderMaxRetryDelayMs}
              maxDomainFanOut={maxDomainFanOut}
              setMaxDomainFanOut={setMaxDomainFanOut}
              maxLeafFanOut={maxLeafFanOut}
              setMaxLeafFanOut={setMaxLeafFanOut}
              maxActiveRuns={maxActiveRuns}
              setMaxActiveRuns={setMaxActiveRuns}
              maxConcurrentAttempts={maxConcurrentAttempts}
              setMaxConcurrentAttempts={setMaxConcurrentAttempts}
              planScoutCount={planScoutCount}
              setPlanScoutCount={setPlanScoutCount}
              reviewCouncilSize={reviewCouncilSize}
              setReviewCouncilSize={setReviewCouncilSize}
              reviewConcurrency={reviewConcurrency}
              setReviewConcurrency={setReviewConcurrency}
              domainConcurrency={domainConcurrency}
              setDomainConcurrency={setDomainConcurrency}
              leafConcurrency={leafConcurrency}
              setLeafConcurrency={setLeafConcurrency}
              plannerProfileId={plannerProfileId}
              setPlannerProfileId={setPlannerProfileId}
              workerProfileId={workerProfileId}
              setWorkerProfileId={setWorkerProfileId}
              writerProfileId={writerProfileId}
              setWriterProfileId={setWriterProfileId}
            />
          ) : null}
          {section === "skill" ? (
            <SkillSection
              workspaceId={id}
              models={models}
              skill={skill}
              skillBusy={skillBusy}
              skillFilePath={skillFilePath}
              skillFileContent={skillFileContent}
              skillFileDirty={skillFileDirty}
              setSkill={setSkill}
              setSkillBusy={setSkillBusy}
              setSkillFilePath={setSkillFilePath}
              setSkillFileContent={setSkillFileContent}
              setSkillFileDirty={setSkillFileDirty}
              applyWorkspace={applyWorkspace}
            />
          ) : null}
          {section === "danger" ? (
            <DangerSection
              deleting={deleting}
              onRequestDelete={() => {
                setDeleteMeta(false);
                setDeleteDialogOpen(true);
              }}
            />
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
