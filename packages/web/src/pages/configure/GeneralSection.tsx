import { type FormEvent } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import type { ModelProfilePublic, WikiLanguage, WorkspaceConfig } from "../../api";
import { ModelSelect } from "../../components/ModelSelect";
import { formatMessage, useI18n } from "../../i18n";
import type {
  CoverageRequirementUi,
  GeneralFieldErrorKey,
  PlanScoutModeUi,
} from "./useWorkspaceGeneralForm";

export type GeneralSectionProps = {
  workspace: WorkspaceConfig;
  models: ModelProfilePublic[];
  defaultModelProfileId: string | undefined;
  isSubmitting: boolean;
  isDirty: boolean;
  onSubmit: (event: FormEvent) => void;
  fieldErrors?: Partial<Record<GeneralFieldErrorKey, string>>;
  onClearFieldError?: (key: GeneralFieldErrorKey) => void;
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
  planScoutMode: PlanScoutModeUi;
  setPlanScoutMode: (value: PlanScoutModeUi) => void;
  planScoutCount: string;
  setPlanScoutCount: (value: string) => void;
  planScoutConcurrency: string;
  setPlanScoutConcurrency: (value: string) => void;
  planSurveyTaskBudget: string;
  setPlanSurveyTaskBudget: (value: string) => void;
  planRescoutMaxRounds: string;
  setPlanRescoutMaxRounds: (value: string) => void;
  requireSourceCoverage: CoverageRequirementUi;
  setRequireSourceCoverage: (value: CoverageRequirementUi) => void;
  requireSurfaceCoverage: CoverageRequirementUi;
  setRequireSurfaceCoverage: (value: CoverageRequirementUi) => void;
  maxSourcesPerRun: string;
  setMaxSourcesPerRun: (value: string) => void;
  maxSurfacesRequired: string;
  setMaxSurfacesRequired: (value: string) => void;
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

export function GeneralSection({ isSubmitting, isDirty, ...props }: GeneralSectionProps) {
  const { t } = useI18n();
  const {
    workspace,
    models,
    defaultModelProfileId,
    onSubmit,
    fieldErrors = {},
    onClearFieldError,
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
    planScoutMode,
    setPlanScoutMode,
    planScoutCount,
    setPlanScoutCount,
    planScoutConcurrency,
    setPlanScoutConcurrency,
    planSurveyTaskBudget,
    setPlanSurveyTaskBudget,
    planRescoutMaxRounds,
    setPlanRescoutMaxRounds,
    requireSourceCoverage,
    setRequireSourceCoverage,
    requireSurfaceCoverage,
    setRequireSurfaceCoverage,
    maxSourcesPerRun,
    setMaxSourcesPerRun,
    maxSurfacesRequired,
    setMaxSurfacesRequired,
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
  } = props;

  const selectedModel = models.find((m) => m.id === modelProfileId);
  const orphanModelId =
    !selectedModel && workspace.model.id && !models.some((m) => m.modelId === workspace.model.id)
      ? workspace.model.id
      : null;
  /** 85% of model max when workspace target is blank (matches agent CONTEXT_COMPACTION_RATIO). */
  const derivedContextTarget =
    !contextTargetTokens.trim() && selectedModel?.maxContextTokens !== undefined
      ? Math.floor(selectedModel.maxContextTokens * 0.85)
      : undefined;

  function editField(key: GeneralFieldErrorKey, setter: (value: string) => void) {
    return (value: string) => {
      onClearFieldError?.(key);
      setter(value);
    };
  }

  const contextTargetInvalid = Boolean(fieldErrors.contextTargetTokens);
  const requestTimeoutInvalid = Boolean(fieldErrors.requestTimeoutSeconds);
  const gateTimeoutInvalid = Boolean(fieldErrors.gateTimeoutSeconds);
  const retryMaxInvalid = Boolean(fieldErrors.retryMaxRetries);
  const retryBaseDelayInvalid = Boolean(fieldErrors.retryBaseDelayMs);
  const providerMaxRetriesInvalid = Boolean(fieldErrors.providerMaxRetries);
  const providerMaxRetryDelayInvalid = Boolean(fieldErrors.providerMaxRetryDelayMs);

  const canSave =
    isDirty &&
    !isSubmitting &&
    Boolean(name.trim()) &&
    Boolean(publicationPath.trim()) &&
    (models.length === 0 || Boolean(modelProfileId));

  return (
    <div className="flex w-full flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.settings.tabGeneral}</CardTitle>
          <CardDescription>{t.settings.generalCardDescription}</CardDescription>
        </CardHeader>
        <form onSubmit={(e) => void onSubmit(e)}>
          <CardContent className="flex flex-col gap-2">
            <Accordion multiple defaultValue={["identity"]} className="w-full">
              <AccordionItem value="identity">
                <AccordionTrigger>{t.settings.sectionIdentity}</AccordionTrigger>
                <AccordionContent>
                  <FieldSet>
                    <FieldLegend className="sr-only">{t.settings.sectionIdentity}</FieldLegend>
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
                        <p className="text-sm text-muted-foreground" data-testid="settings-model-orphan">
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
                    </FieldGroup>
                  </FieldSet>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="session">
                <AccordionTrigger>{t.settings.sectionSession}</AccordionTrigger>
                <AccordionContent>
                  <FieldSet>
                    <FieldLegend className="sr-only">{t.settings.sectionSession}</FieldLegend>
                    <FieldGroup>
                      <Field data-invalid={contextTargetInvalid || undefined}>
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
                            editField("contextTargetTokens", setContextTargetTokens)(e.target.value);
                          }}
                          placeholder={t.settings.contextTargetTokensPlaceholder}
                          className="max-w-xs font-mono"
                          data-testid="settings-context-target"
                          aria-invalid={contextTargetInvalid || undefined}
                          aria-describedby={
                            contextTargetInvalid ? "settings-context-target-error" : undefined
                          }
                          aria-errormessage="settings-context-target-error"
                        />
                        {fieldErrors.contextTargetTokens ? (
                          <FieldError id="settings-context-target-error">
                            {fieldErrors.contextTargetTokens}
                          </FieldError>
                        ) : null}
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

                      <Field data-invalid={requestTimeoutInvalid || undefined}>
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
                            editField(
                              "requestTimeoutSeconds",
                              setRequestTimeoutSeconds,
                            )(e.target.value);
                          }}
                          placeholder={t.settings.requestTimeoutSecondsPlaceholder}
                          className="max-w-xs font-mono"
                          data-testid="settings-request-timeout"
                          required
                          aria-invalid={requestTimeoutInvalid || undefined}
                          aria-errormessage="settings-request-timeout-error"
                        />
                        {fieldErrors.requestTimeoutSeconds ? (
                          <FieldError id="settings-request-timeout-error">
                            {fieldErrors.requestTimeoutSeconds}
                          </FieldError>
                        ) : null}
                        <FieldDescription>{t.settings.requestTimeoutSecondsHint}</FieldDescription>
                      </Field>

                      <Field data-invalid={gateTimeoutInvalid || undefined}>
                        <FieldLabel htmlFor="settings-gate-timeout">
                          {t.settings.gateTimeoutSeconds}
                        </FieldLabel>
                        <Input
                          id="settings-gate-timeout"
                          type="number"
                          min={0}
                          max={604800}
                          step={1}
                          value={gateTimeoutSeconds}
                          onChange={(e) => {
                            editField("gateTimeoutSeconds", setGateTimeoutSeconds)(e.target.value);
                          }}
                          placeholder={t.settings.gateTimeoutSecondsPlaceholder}
                          className="max-w-xs font-mono"
                          data-testid="settings-gate-timeout"
                          aria-invalid={gateTimeoutInvalid || undefined}
                          aria-errormessage="settings-gate-timeout-error"
                        />
                        {fieldErrors.gateTimeoutSeconds ? (
                          <FieldError id="settings-gate-timeout-error">
                            {fieldErrors.gateTimeoutSeconds}
                          </FieldError>
                        ) : null}
                        <FieldDescription>{t.settings.gateTimeoutSecondsHint}</FieldDescription>
                      </Field>
                    </FieldGroup>
                  </FieldSet>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="retry">
                <AccordionTrigger>{t.settings.retryTitle}</AccordionTrigger>
                <AccordionContent>
                  <FieldSet>
                    <FieldLegend className="sr-only">{t.settings.retryTitle}</FieldLegend>
                    <FieldDescription className="mb-3">{t.settings.retryHint}</FieldDescription>
                    <FieldGroup>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldLabel htmlFor="settings-retry-enabled">
                            {t.settings.retryEnabled}
                          </FieldLabel>
                        </FieldContent>
                        <Switch
                          id="settings-retry-enabled"
                          checked={retryEnabled}
                          onCheckedChange={setRetryEnabled}
                          data-testid="settings-retry-enabled"
                        />
                      </Field>
                      <div className="flex flex-wrap gap-3">
                        <Field
                          data-invalid={retryMaxInvalid || undefined}
                          className="w-auto flex-col gap-1"
                        >
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
                              editField("retryMaxRetries", setRetryMaxRetries)(e.target.value);
                            }}
                            className="w-24 font-mono"
                            data-testid="settings-retry-max"
                            disabled={!retryEnabled}
                            title={t.settings.retryMaxRetriesHint}
                            aria-invalid={retryMaxInvalid || undefined}
                            aria-errormessage="settings-retry-max-error"
                          />
                          {fieldErrors.retryMaxRetries ? (
                            <FieldError id="settings-retry-max-error">
                              {fieldErrors.retryMaxRetries}
                            </FieldError>
                          ) : null}
                        </Field>
                        <Field
                          data-invalid={retryBaseDelayInvalid || undefined}
                          className="w-auto flex-col gap-1"
                        >
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
                              editField("retryBaseDelayMs", setRetryBaseDelayMs)(e.target.value);
                            }}
                            className="w-28 font-mono"
                            data-testid="settings-retry-base-delay"
                            disabled={!retryEnabled}
                            title={t.settings.retryBaseDelayMsHint}
                            aria-invalid={retryBaseDelayInvalid || undefined}
                            aria-errormessage="settings-retry-base-delay-error"
                          />
                          {fieldErrors.retryBaseDelayMs ? (
                            <FieldError id="settings-retry-base-delay-error">
                              {fieldErrors.retryBaseDelayMs}
                            </FieldError>
                          ) : null}
                        </Field>
                        <Field
                          data-invalid={providerMaxRetriesInvalid || undefined}
                          className="w-auto flex-col gap-1"
                        >
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
                              editField("providerMaxRetries", setProviderMaxRetries)(
                                e.target.value,
                              );
                            }}
                            className="w-24 font-mono"
                            data-testid="settings-provider-max-retries"
                            disabled={!retryEnabled}
                            title={t.settings.providerMaxRetriesHint}
                            aria-invalid={providerMaxRetriesInvalid || undefined}
                            aria-errormessage="settings-provider-max-retries-error"
                          />
                          {fieldErrors.providerMaxRetries ? (
                            <FieldError id="settings-provider-max-retries-error">
                              {fieldErrors.providerMaxRetries}
                            </FieldError>
                          ) : null}
                        </Field>
                        <Field
                          data-invalid={providerMaxRetryDelayInvalid || undefined}
                          className="w-auto flex-col gap-1"
                        >
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
                              editField(
                                "providerMaxRetryDelayMs",
                                setProviderMaxRetryDelayMs,
                              )(e.target.value);
                            }}
                            className="w-28 font-mono"
                            data-testid="settings-provider-max-retry-delay"
                            disabled={!retryEnabled}
                            title={t.settings.providerMaxRetryDelayMsHint}
                            aria-invalid={providerMaxRetryDelayInvalid || undefined}
                            aria-errormessage="settings-provider-max-retry-delay-error"
                          />
                          {fieldErrors.providerMaxRetryDelayMs ? (
                            <FieldError id="settings-provider-max-retry-delay-error">
                              {fieldErrors.providerMaxRetryDelayMs}
                            </FieldError>
                          ) : null}
                        </Field>
                      </div>
                    </FieldGroup>
                  </FieldSet>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="orchestration">
                <AccordionTrigger>{t.settings.orchestrationTitle}</AccordionTrigger>
                <AccordionContent>
                  <FieldSet>
                    <FieldLegend className="sr-only">{t.settings.orchestrationTitle}</FieldLegend>
                    <FieldDescription className="mb-3">
                      {t.settings.orchestrationHint}
                    </FieldDescription>
                    <FieldGroup>
                      <div className="flex flex-wrap gap-3">
                        <Field className="w-auto flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-max-active-runs"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.maxActiveRuns}
                          </FieldLabel>
                          <Input
                            id="settings-max-active-runs"
                            type="number"
                            min={1}
                            max={32}
                            value={maxActiveRuns}
                            onChange={(e) => setMaxActiveRuns(e.target.value)}
                            className="w-24 font-mono"
                            data-testid="settings-max-active-runs"
                            required
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-max-concurrent-attempts"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.maxConcurrentAttempts}
                          </FieldLabel>
                          <Input
                            id="settings-max-concurrent-attempts"
                            type="number"
                            min={1}
                            max={128}
                            value={maxConcurrentAttempts}
                            onChange={(e) => setMaxConcurrentAttempts(e.target.value)}
                            className="w-24 font-mono"
                            data-testid="settings-max-concurrent-attempts"
                            required
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
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
                            className="w-24 font-mono"
                            data-testid="settings-max-domain-fanout"
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
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
                            className="w-24 font-mono"
                            data-testid="settings-max-leaf-fanout"
                            title={t.settings.maxLeafFanOutHint}
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
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
                            className="w-24 font-mono"
                            data-testid="settings-review-council-size"
                            title={t.settings.reviewCouncilSizeHint}
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
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
                            placeholder={reviewCouncilSize || "1"}
                            value={reviewConcurrency}
                            onChange={(e) => {
                              setReviewConcurrency(e.target.value);
                            }}
                            className="w-24 font-mono"
                            data-testid="settings-review-concurrency"
                            title={t.settings.reviewConcurrencyHint}
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
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
                            className="w-24 font-mono"
                            data-testid="settings-domain-concurrency"
                            title={t.settings.domainConcurrencyHint}
                          />
                        </Field>
                        <Field className="w-auto flex-col gap-1">
                          <FieldLabel
                            htmlFor="settings-leaf-concurrency"
                            className="text-xs text-muted-foreground"
                          >
                            {t.settings.leafConcurrency}
                          </FieldLabel>
                          <Input
                            id="settings-leaf-concurrency"
                            type="number"
                            min={1}
                            max={16}
                            value={leafConcurrency}
                            onChange={(e) => {
                              setLeafConcurrency(e.target.value);
                            }}
                            className="w-24 font-mono"
                            data-testid="settings-leaf-concurrency"
                            title={t.settings.leafConcurrencyHint}
                          />
                        </Field>
                      </div>
                    </FieldGroup>
                    <FieldDescription className="mt-2 text-xs">
                      {t.settings.reviewCouncilSizeHint} {t.settings.domainConcurrencyHint}{" "}
                      {t.settings.leafConcurrencyHint} {t.settings.maxLeafFanOutHint}
                    </FieldDescription>

                    <div className="mt-4 border-t border-border pt-4">
                      <p className="mb-1 text-sm font-medium">
                        {t.settings.planCoverageTitle}
                      </p>
                      <FieldDescription className="mb-3">
                        {t.settings.planCoverageHint}
                      </FieldDescription>
                      <FieldGroup>
                        <div className="flex flex-wrap gap-3">
                          <Field className="w-auto min-w-36 flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-plan-scout-mode"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.planScoutMode}
                            </FieldLabel>
                            <Select
                              value={planScoutMode}
                              onValueChange={(next) => {
                                if (
                                  next === "auto" ||
                                  next === "thematic" ||
                                  next === "source" ||
                                  next === "hybrid"
                                ) {
                                  setPlanScoutMode(next);
                                }
                              }}
                              items={[
                                { value: "auto", label: t.settings.planScoutModeAuto },
                                {
                                  value: "thematic",
                                  label: t.settings.planScoutModeThematic,
                                },
                                { value: "source", label: t.settings.planScoutModeSource },
                                { value: "hybrid", label: t.settings.planScoutModeHybrid },
                              ]}
                            >
                              <SelectTrigger
                                id="settings-plan-scout-mode"
                                className="w-36"
                                data-testid="settings-plan-scout-mode"
                                data-value={planScoutMode}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="auto">
                                    {t.settings.planScoutModeAuto}
                                  </SelectItem>
                                  <SelectItem value="thematic">
                                    {t.settings.planScoutModeThematic}
                                  </SelectItem>
                                  <SelectItem value="source">
                                    {t.settings.planScoutModeSource}
                                  </SelectItem>
                                  <SelectItem value="hybrid">
                                    {t.settings.planScoutModeHybrid}
                                  </SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field className="w-auto flex-col gap-1">
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
                              className="w-24 font-mono"
                              data-testid="settings-plan-scout-count"
                              title={t.settings.planScoutCountHint}
                            />
                          </Field>
                          <Field className="w-auto flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-plan-scout-concurrency"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.planScoutConcurrency}
                            </FieldLabel>
                            <Input
                              id="settings-plan-scout-concurrency"
                              type="number"
                              min={1}
                              max={4}
                              placeholder={planScoutCount || "1"}
                              value={planScoutConcurrency}
                              onChange={(e) => {
                                setPlanScoutConcurrency(e.target.value);
                              }}
                              className="w-24 font-mono"
                              data-testid="settings-plan-scout-concurrency"
                              title={t.settings.planScoutConcurrencyHint}
                            />
                          </Field>
                          <Field className="w-auto flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-plan-survey-task-budget"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.planSurveyTaskBudget}
                            </FieldLabel>
                            <Input
                              id="settings-plan-survey-task-budget"
                              type="number"
                              min={0}
                              max={32}
                              placeholder={t.settings.planSurveyTaskBudgetPlaceholder}
                              value={planSurveyTaskBudget}
                              onChange={(e) => {
                                setPlanSurveyTaskBudget(e.target.value);
                              }}
                              className="w-24 font-mono"
                              data-testid="settings-plan-survey-task-budget"
                              title={t.settings.planSurveyTaskBudgetHint}
                            />
                          </Field>
                          <Field className="w-auto flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-plan-rescout-max-rounds"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.planRescoutMaxRounds}
                            </FieldLabel>
                            <Input
                              id="settings-plan-rescout-max-rounds"
                              type="number"
                              min={0}
                              max={4}
                              value={planRescoutMaxRounds}
                              onChange={(e) => {
                                setPlanRescoutMaxRounds(e.target.value);
                              }}
                              className="w-24 font-mono"
                              data-testid="settings-plan-rescout-max-rounds"
                              title={t.settings.planRescoutMaxRoundsHint}
                            />
                          </Field>
                          <Field className="w-auto min-w-36 flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-require-source-coverage"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.requireSourceCoverage}
                            </FieldLabel>
                            <Select
                              value={requireSourceCoverage}
                              onValueChange={(next) => {
                                if (next === "auto" || next === "on" || next === "off") {
                                  setRequireSourceCoverage(next);
                                }
                              }}
                              items={[
                                { value: "auto", label: t.settings.coverageRequirementAuto },
                                { value: "on", label: t.settings.coverageRequirementOn },
                                { value: "off", label: t.settings.coverageRequirementOff },
                              ]}
                            >
                              <SelectTrigger
                                id="settings-require-source-coverage"
                                className="w-36"
                                data-testid="settings-require-source-coverage"
                                data-value={requireSourceCoverage}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="auto">
                                    {t.settings.coverageRequirementAuto}
                                  </SelectItem>
                                  <SelectItem value="on">
                                    {t.settings.coverageRequirementOn}
                                  </SelectItem>
                                  <SelectItem value="off">
                                    {t.settings.coverageRequirementOff}
                                  </SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field className="w-auto min-w-36 flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-require-surface-coverage"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.requireSurfaceCoverage}
                            </FieldLabel>
                            <Select
                              value={requireSurfaceCoverage}
                              onValueChange={(next) => {
                                if (next === "auto" || next === "on" || next === "off") {
                                  setRequireSurfaceCoverage(next);
                                }
                              }}
                              items={[
                                { value: "auto", label: t.settings.coverageRequirementAuto },
                                { value: "on", label: t.settings.coverageRequirementOn },
                                { value: "off", label: t.settings.coverageRequirementOff },
                              ]}
                            >
                              <SelectTrigger
                                id="settings-require-surface-coverage"
                                className="w-36"
                                data-testid="settings-require-surface-coverage"
                                data-value={requireSurfaceCoverage}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectGroup>
                                  <SelectItem value="auto">
                                    {t.settings.coverageRequirementAuto}
                                  </SelectItem>
                                  <SelectItem value="on">
                                    {t.settings.coverageRequirementOn}
                                  </SelectItem>
                                  <SelectItem value="off">
                                    {t.settings.coverageRequirementOff}
                                  </SelectItem>
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field className="w-auto flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-max-sources-per-run"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.maxSourcesPerRun}
                            </FieldLabel>
                            <Input
                              id="settings-max-sources-per-run"
                              type="number"
                              min={1}
                              max={16}
                              value={maxSourcesPerRun}
                              onChange={(e) => {
                                setMaxSourcesPerRun(e.target.value);
                              }}
                              className="w-24 font-mono"
                              data-testid="settings-max-sources-per-run"
                              title={t.settings.maxSourcesPerRunHint}
                            />
                          </Field>
                          <Field className="w-auto flex-col gap-1">
                            <FieldLabel
                              htmlFor="settings-max-surfaces-required"
                              className="text-xs text-muted-foreground"
                            >
                              {t.settings.maxSurfacesRequired}
                            </FieldLabel>
                            <Input
                              id="settings-max-surfaces-required"
                              type="number"
                              min={1}
                              max={48}
                              value={maxSurfacesRequired}
                              onChange={(e) => {
                                setMaxSurfacesRequired(e.target.value);
                              }}
                              className="w-24 font-mono"
                              data-testid="settings-max-surfaces-required"
                              title={t.settings.maxSurfacesRequiredHint}
                            />
                          </Field>
                        </div>
                      </FieldGroup>
                      <FieldDescription className="mt-2 text-xs">
                        {t.settings.planScoutCountHint} {t.settings.planSurveyTaskBudgetHint}
                      </FieldDescription>
                    </div>
                  </FieldSet>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="roles">
                <AccordionTrigger>{t.settings.roleModelsTitle}</AccordionTrigger>
                <AccordionContent>
                  <FieldSet>
                    <FieldLegend className="sr-only">{t.settings.roleModelsTitle}</FieldLegend>
                    <FieldDescription className="mb-3">{t.settings.roleModelsHint}</FieldDescription>
                    <FieldGroup>
                      <ModelSelect
                        models={models}
                        value={plannerProfileId}
                        onChange={(next) => {
                          setPlannerProfileId(next);
                        }}
                        defaultModelProfileId={defaultModelProfileId}
                        label={t.settings.rolePlanner}
                        hideDescription
                        allowEmpty
                        data-testid="settings-role-planner"
                      />
                      <ModelSelect
                        models={models}
                        value={workerProfileId}
                        onChange={(next) => {
                          setWorkerProfileId(next);
                        }}
                        defaultModelProfileId={defaultModelProfileId}
                        label={t.settings.roleWorker}
                        hideDescription
                        allowEmpty
                        data-testid="settings-role-worker"
                      />
                      <ModelSelect
                        models={models}
                        value={writerProfileId}
                        onChange={(next) => {
                          setWriterProfileId(next);
                        }}
                        defaultModelProfileId={defaultModelProfileId}
                        label={t.settings.roleWriter}
                        hideDescription
                        allowEmpty
                        data-testid="settings-role-writer"
                      />
                    </FieldGroup>
                  </FieldSet>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button type="submit" disabled={!canSave} data-testid="settings-save">
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {isSubmitting ? t.settings.saving : t.settings.save}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.settings.metaTitle}</CardTitle>
          <CardDescription>{t.settings.metaDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-muted-foreground">{t.settings.rootPath}</dt>
            <dd className="font-mono break-all">{workspace.rootPath}</dd>
            <dt className="text-muted-foreground">{t.common.id}</dt>
            <dd className="font-mono break-all">{workspace.id}</dd>
            <dt className="text-muted-foreground">{t.settings.selectedModelId}</dt>
            <dd className="font-mono break-all">{workspace.model.id}</dd>
            {workspace.model.profileId ? (
              <>
                <dt className="text-muted-foreground">{t.settings.modelProfile}</dt>
                <dd className="font-mono break-all">{workspace.model.profileId}</dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
