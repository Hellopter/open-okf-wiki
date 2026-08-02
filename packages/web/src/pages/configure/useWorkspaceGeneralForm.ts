import { DEFAULT_ORCHESTRATION } from "@okf-wiki/contract";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getProvider,
  type ModelProfilePublic,
  patchWorkspace,
  type WikiLanguage,
  type WorkspaceConfig,
  workspaceFromRevisionConflict,
} from "../../api";
import { useI18n } from "../../i18n";
import { notifyError, notifySuccess } from "../../lib/notify";

export type GeneralFieldErrorKey =
  | "contextTargetTokens"
  | "requestTimeoutSeconds"
  | "gateTimeoutSeconds"
  | "retryMaxRetries"
  | "retryBaseDelayMs"
  | "providerMaxRetries"
  | "providerMaxRetryDelayMs";

export type WorkspaceGeneralForm = {
  models: ModelProfilePublic[];
  defaultModelProfileId: string | undefined;
  loading: boolean;
  loadError: unknown;
  setLoadError: (err: unknown) => void;
  fieldErrors: Partial<Record<GeneralFieldErrorKey, string>>;
  clearFieldError: (key: GeneralFieldErrorKey) => void;
  isSubmitting: boolean;
  isDirty: boolean;
  handleSubmit: (event: FormEvent) => void;
  applyWorkspace: (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => void;
  /**
   * Skip the next workspace→form hydrate/loading flash for this workspace id.
   * Call before onWorkspaceChange / applyWorkspace on successful local mutations
   * (sources, skill, general save). Do not call on revision-conflict re-apply so
   * the form still rehydrates from the server workspace.
   */
  skipNextWorkspaceHydrate: (workspaceId: string) => void;
  name: string;
  setName: (value: string) => void;
  modelProfileId: string;
  setModelProfileId: (value: string) => void;
  publicationPath: string;
  setPublicationPath: (value: string) => void;
  planConfirm: boolean;
  setPlanConfirm: (value: boolean) => void;
  wikiLanguage: WikiLanguage;
  setWikiLanguage: (value: WikiLanguage) => void;
  contextTargetTokens: string;
  setContextTargetTokens: (value: string) => void;
  requestTimeoutSeconds: string;
  setRequestTimeoutSeconds: (value: string) => void;
  gateTimeoutSeconds: string;
  setGateTimeoutSeconds: (value: string) => void;
  retryEnabled: boolean;
  setRetryEnabled: (value: boolean) => void;
  retryMaxRetries: string;
  setRetryMaxRetries: (value: string) => void;
  retryBaseDelayMs: string;
  setRetryBaseDelayMs: (value: string) => void;
  providerMaxRetries: string;
  setProviderMaxRetries: (value: string) => void;
  providerMaxRetryDelayMs: string;
  setProviderMaxRetryDelayMs: (value: string) => void;
  maxDomainFanOut: string;
  setMaxDomainFanOut: (value: string) => void;
  maxLeafFanOut: string;
  setMaxLeafFanOut: (value: string) => void;
  maxActiveRuns: string;
  setMaxActiveRuns: (value: string) => void;
  maxConcurrentAttempts: string;
  setMaxConcurrentAttempts: (value: string) => void;
  planScoutCount: string;
  setPlanScoutCount: (value: string) => void;
  reviewCouncilSize: string;
  setReviewCouncilSize: (value: string) => void;
  reviewConcurrency: string;
  setReviewConcurrency: (value: string) => void;
  domainConcurrency: string;
  setDomainConcurrency: (value: string) => void;
  leafConcurrency: string;
  setLeafConcurrency: (value: string) => void;
  plannerProfileId: string;
  setPlannerProfileId: (value: string) => void;
  workerProfileId: string;
  setWorkerProfileId: (value: string) => void;
  writerProfileId: string;
  setWriterProfileId: (value: string) => void;
};

/**
 * Form state, validation, dirty tracking, and patch for Configure → General.
 * applyWorkspace also serves skill/danger paths that need revision sync.
 */
export function useWorkspaceGeneralForm(
  workspace: WorkspaceConfig,
  onWorkspaceChange: (workspace: WorkspaceConfig) => void,
): WorkspaceGeneralForm {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<GeneralFieldErrorKey, string>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

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
  const skipWorkspaceReloadRef = useRef<string | null>(null);
  /** Baseline snapshot for dirty detection (stringified after apply). */
  const baselineRef = useRef<string>("");

  const snapshotFields = useCallback(
    (fields: {
      name: string;
      modelProfileId: string;
      publicationPath: string;
      planConfirm: boolean;
      wikiLanguage: WikiLanguage;
      contextTargetTokens: string;
      requestTimeoutSeconds: string;
      gateTimeoutSeconds: string;
      retryEnabled: boolean;
      retryMaxRetries: string;
      retryBaseDelayMs: string;
      providerMaxRetries: string;
      providerMaxRetryDelayMs: string;
      maxDomainFanOut: string;
      maxLeafFanOut: string;
      maxActiveRuns: string;
      maxConcurrentAttempts: string;
      planScoutCount: string;
      reviewCouncilSize: string;
      reviewConcurrency: string;
      domainConcurrency: string;
      leafConcurrency: string;
      plannerProfileId: string;
      workerProfileId: string;
      writerProfileId: string;
    }) => JSON.stringify(fields),
    [],
  );

  const clearFieldError = useCallback((key: GeneralFieldErrorKey) => {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const skipNextWorkspaceHydrate = useCallback((workspaceId: string) => {
    skipWorkspaceReloadRef.current = workspaceId;
  }, []);

  const applyWorkspace = useCallback(
    (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => {
      onWorkspaceChange(ws);
      const nextName = ws.name;
      const nextPublicationPath = ws.publicationPath;
      const nextPlanConfirm = Boolean(ws.planConfirm);
      const nextWikiLanguage = ws.wikiLanguage ?? "en";
      const nextContextTargetTokens =
        ws.limits?.contextTargetTokens !== undefined ? String(ws.limits.contextTargetTokens) : "";
      const nextRequestTimeoutSeconds = String(ws.limits?.requestTimeoutSeconds ?? 600);
      const nextGateTimeoutSeconds = String(ws.limits?.gateTimeoutSeconds ?? 0);
      const nextRetryEnabled = ws.limits?.retry?.enabled !== false;
      const nextRetryMaxRetries = String(ws.limits?.retry?.maxRetries ?? 2);
      const nextRetryBaseDelayMs = String(ws.limits?.retry?.baseDelayMs ?? 2000);
      const nextProviderMaxRetries = String(ws.limits?.retry?.provider?.maxRetries ?? 0);
      const nextProviderMaxRetryDelayMs = String(
        ws.limits?.retry?.provider?.maxRetryDelayMs ?? 60_000,
      );
      const nextMaxDomainFanOut = String(ws.orchestration?.maxDomainFanOut ?? 4);
      const nextMaxLeafFanOut = String(ws.orchestration?.maxLeafFanOut ?? 6);
      const nextMaxActiveRuns = String(ws.orchestration.maxActiveRuns);
      const nextMaxConcurrentAttempts = String(ws.orchestration.maxConcurrentAttempts);
      const nextPlanScoutCount = String(
        ws.orchestration?.planScoutCount ?? DEFAULT_ORCHESTRATION.planScoutCount,
      );
      const nextReviewCouncilSize = String(
        ws.orchestration?.reviewCouncilSize ?? DEFAULT_ORCHESTRATION.reviewCouncilSize,
      );
      const nextReviewConcurrency =
        ws.orchestration?.reviewConcurrency !== undefined
          ? String(ws.orchestration.reviewConcurrency)
          : "";
      const nextDomainConcurrency = String(ws.orchestration?.domainConcurrency ?? 2);
      const nextLeafConcurrency = String(ws.orchestration?.leafConcurrency ?? 2);
      const nextPlannerProfileId = ws.roleModels?.planner?.profileId ?? "";
      const nextWorkerProfileId = ws.roleModels?.worker?.profileId ?? "";
      const nextWriterProfileId = ws.roleModels?.writer?.profileId ?? "";

      let nextModelProfileId = "";
      if (ws.model.profileId && catalog.some((m) => m.id === ws.model.profileId)) {
        nextModelProfileId = ws.model.profileId;
      } else {
        const byModelId = catalog.find((m) => m.modelId === ws.model.id);
        nextModelProfileId = byModelId?.id ?? ws.model.profileId ?? "";
      }

      setName(nextName);
      setPublicationPath(nextPublicationPath);
      setPlanConfirm(nextPlanConfirm);
      setWikiLanguage(nextWikiLanguage);
      setContextTargetTokens(nextContextTargetTokens);
      setRequestTimeoutSeconds(nextRequestTimeoutSeconds);
      setGateTimeoutSeconds(nextGateTimeoutSeconds);
      setRetryEnabled(nextRetryEnabled);
      setRetryMaxRetries(nextRetryMaxRetries);
      setRetryBaseDelayMs(nextRetryBaseDelayMs);
      setProviderMaxRetries(nextProviderMaxRetries);
      setProviderMaxRetryDelayMs(nextProviderMaxRetryDelayMs);
      setMaxDomainFanOut(nextMaxDomainFanOut);
      setMaxLeafFanOut(nextMaxLeafFanOut);
      setMaxActiveRuns(nextMaxActiveRuns);
      setMaxConcurrentAttempts(nextMaxConcurrentAttempts);
      setPlanScoutCount(nextPlanScoutCount);
      setReviewCouncilSize(nextReviewCouncilSize);
      setReviewConcurrency(nextReviewConcurrency);
      setDomainConcurrency(nextDomainConcurrency);
      setLeafConcurrency(nextLeafConcurrency);
      setPlannerProfileId(nextPlannerProfileId);
      setWorkerProfileId(nextWorkerProfileId);
      setWriterProfileId(nextWriterProfileId);
      setModelProfileId(nextModelProfileId);

      baselineRef.current = snapshotFields({
        name: nextName,
        modelProfileId: nextModelProfileId,
        publicationPath: nextPublicationPath,
        planConfirm: nextPlanConfirm,
        wikiLanguage: nextWikiLanguage,
        contextTargetTokens: nextContextTargetTokens,
        requestTimeoutSeconds: nextRequestTimeoutSeconds,
        gateTimeoutSeconds: nextGateTimeoutSeconds,
        retryEnabled: nextRetryEnabled,
        retryMaxRetries: nextRetryMaxRetries,
        retryBaseDelayMs: nextRetryBaseDelayMs,
        providerMaxRetries: nextProviderMaxRetries,
        providerMaxRetryDelayMs: nextProviderMaxRetryDelayMs,
        maxDomainFanOut: nextMaxDomainFanOut,
        maxLeafFanOut: nextMaxLeafFanOut,
        maxActiveRuns: nextMaxActiveRuns,
        maxConcurrentAttempts: nextMaxConcurrentAttempts,
        planScoutCount: nextPlanScoutCount,
        reviewCouncilSize: nextReviewCouncilSize,
        reviewConcurrency: nextReviewConcurrency,
        domainConcurrency: nextDomainConcurrency,
        leafConcurrency: nextLeafConcurrency,
        plannerProfileId: nextPlannerProfileId,
        workerProfileId: nextWorkerProfileId,
        writerProfileId: nextWriterProfileId,
      });
    },
    [onWorkspaceChange, snapshotFields],
  );

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
      } catch (err) {
        if (!cancelled) {
          setLoadError(err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, applyWorkspace]);

  const isDirty = useMemo(
    () =>
      baselineRef.current !==
      snapshotFields({
        name,
        modelProfileId,
        publicationPath,
        planConfirm,
        wikiLanguage,
        contextTargetTokens,
        requestTimeoutSeconds,
        gateTimeoutSeconds,
        retryEnabled,
        retryMaxRetries,
        retryBaseDelayMs,
        providerMaxRetries,
        providerMaxRetryDelayMs,
        maxDomainFanOut,
        maxLeafFanOut,
        maxActiveRuns,
        maxConcurrentAttempts,
        planScoutCount,
        reviewCouncilSize,
        reviewConcurrency,
        domainConcurrency,
        leafConcurrency,
        plannerProfileId,
        workerProfileId,
        writerProfileId,
      }),
    [
      snapshotFields,
      name,
      modelProfileId,
      publicationPath,
      planConfirm,
      wikiLanguage,
      contextTargetTokens,
      requestTimeoutSeconds,
      gateTimeoutSeconds,
      retryEnabled,
      retryMaxRetries,
      retryBaseDelayMs,
      providerMaxRetries,
      providerMaxRetryDelayMs,
      maxDomainFanOut,
      maxLeafFanOut,
      maxActiveRuns,
      maxConcurrentAttempts,
      planScoutCount,
      reviewCouncilSize,
      reviewConcurrency,
      domainConcurrency,
      leafConcurrency,
      plannerProfileId,
      workerProfileId,
      writerProfileId,
    ],
  );

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
        expectedRevision: workspace.revision,
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
      const latest = workspaceFromRevisionConflict(err);
      if (latest) applyWorkspace(latest, models);
      notifyError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  return {
    models,
    defaultModelProfileId,
    loading,
    loadError,
    setLoadError,
    fieldErrors,
    clearFieldError,
    isSubmitting,
    isDirty,
    handleSubmit,
    applyWorkspace,
    skipNextWorkspaceHydrate,
    name,
    setName,
    modelProfileId,
    setModelProfileId,
    publicationPath,
    setPublicationPath,
    planConfirm,
    setPlanConfirm,
    wikiLanguage,
    setWikiLanguage,
    contextTargetTokens,
    setContextTargetTokens,
    requestTimeoutSeconds,
    setRequestTimeoutSeconds,
    gateTimeoutSeconds,
    setGateTimeoutSeconds,
    retryEnabled,
    setRetryEnabled,
    retryMaxRetries,
    setRetryMaxRetries,
    retryBaseDelayMs,
    setRetryBaseDelayMs,
    providerMaxRetries,
    setProviderMaxRetries,
    providerMaxRetryDelayMs,
    setProviderMaxRetryDelayMs,
    maxDomainFanOut,
    setMaxDomainFanOut,
    maxLeafFanOut,
    setMaxLeafFanOut,
    maxActiveRuns,
    setMaxActiveRuns,
    maxConcurrentAttempts,
    setMaxConcurrentAttempts,
    planScoutCount,
    setPlanScoutCount,
    reviewCouncilSize,
    setReviewCouncilSize,
    reviewConcurrency,
    setReviewConcurrency,
    domainConcurrency,
    setDomainConcurrency,
    leafConcurrency,
    setLeafConcurrency,
    plannerProfileId,
    setPlannerProfileId,
    workerProfileId,
    setWorkerProfileId,
    writerProfileId,
    setWriterProfileId,
  };
}
