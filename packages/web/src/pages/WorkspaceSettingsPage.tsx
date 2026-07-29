import { DEFAULT_OPERATOR_TOOLS, type OperatorToolName } from "@okf-wiki/contract";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  deleteWorkspace,
  getProvider,
  getWorkspace,
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
import { DangerSection } from "./workspace-settings/DangerSection";
import { GeneralSection } from "./workspace-settings/GeneralSection";
import { SkillSection } from "./workspace-settings/SkillSection";

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
    setGateTimeoutSeconds(String(ws.limits?.gateTimeoutSeconds ?? 0));
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
      const nextGateTimeout = Number(gateTimeoutSeconds.trim() || "0");
      if (
        !Number.isInteger(nextGateTimeout) ||
        nextGateTimeout < 0 ||
        nextGateTimeout > 604_800
      ) {
        setError(new Error("gateTimeoutSeconds must be an integer from 0 to 604800"));
        setIsSubmitting(false);
        return;
      }
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
            <GeneralSection
              workspace={workspace}
              models={models}
              defaultModelProfileId={defaultModelProfileId}
              isSubmitting={isSubmitting}
              onSubmit={handleSubmit}
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
              planScoutCount={planScoutCount}
              setPlanScoutCount={setPlanScoutCount}
              reviewCouncilSize={reviewCouncilSize}
              setReviewCouncilSize={setReviewCouncilSize}
              reviewConcurrency={reviewConcurrency}
              setReviewConcurrency={setReviewConcurrency}
              domainConcurrency={domainConcurrency}
              setDomainConcurrency={setDomainConcurrency}
              plannerProfileId={plannerProfileId}
              setPlannerProfileId={setPlannerProfileId}
              workerProfileId={workerProfileId}
              setWorkerProfileId={setWorkerProfileId}
              writerProfileId={writerProfileId}
              setWriterProfileId={setWriterProfileId}
              operatorTools={operatorTools}
              setOperatorTools={setOperatorTools}
            />
          ) : null}
          {section === "skill" ? (
            <SkillSection
              workspaceId={id}
              workspace={workspace}
              rootPathHint={rootPathHint}
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
              setError={setError}
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
