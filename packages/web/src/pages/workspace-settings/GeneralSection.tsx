import { type OperatorToolName } from "@okf-wiki/contract";
import { type FormEvent } from "react";
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
import type { ModelProfilePublic, WikiLanguage, WorkspaceConfig } from "../../api";
import { ModelSelect } from "../../components/ModelSelect";
import { formatMessage, useI18n } from "../../i18n";

export type GeneralSectionProps = {
  workspace: WorkspaceConfig;
  models: ModelProfilePublic[];
  defaultModelProfileId: string | undefined;
  isSubmitting: boolean;
  onSubmit: (event: FormEvent) => void;
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
  operatorTools: OperatorToolName[];
  setOperatorTools: (
    value: OperatorToolName[] | ((current: OperatorToolName[]) => OperatorToolName[]),
  ) => void;
};

export function GeneralSection(props: GeneralSectionProps) {
  const { t } = useI18n();
  const {
    workspace,
    models,
    defaultModelProfileId,
    isSubmitting,
    onSubmit,
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
    operatorTools,
    setOperatorTools,
  } = props;

  const selectedModel = models.find((m) => m.id === modelProfileId);
  const orphanModelId =
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

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardContent className="flex flex-col gap-6">
          <form className="max-w-xl" onSubmit={(e) => void onSubmit(e)}>
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
                <FieldLabel htmlFor="settings-publication">{t.settings.publicationPath}</FieldLabel>
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
                <FieldLabel htmlFor="settings-wiki-language">{t.settings.wikiLanguage}</FieldLabel>
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
                  <FieldLabel htmlFor="settings-plan-confirm">{t.settings.planConfirm}</FieldLabel>
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
                  Tools available to the chat agent. File tools are read-only and cannot touch
                  product meta; bash runs unrestricted shell commands in the workspace — enable it
                  only for workspaces you fully trust.
                </FieldDescription>
                <div className="flex flex-wrap gap-4" data-testid="settings-operator-tools">
                  {(["read", "grep", "find", "ls", "bash"] as OperatorToolName[]).map((tool) => (
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
                  ))}
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
                    setGateTimeoutSeconds(e.target.value);
                  }}
                  placeholder={t.settings.gateTimeoutSecondsPlaceholder}
                  className="font-mono max-w-xs"
                  data-testid="settings-gate-timeout"
                />
                <FieldDescription>{t.settings.gateTimeoutSecondsHint}</FieldDescription>
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
                      title={t.settings.maxLeafFanOutHint}
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
                      title={t.settings.domainConcurrencyHint}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
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
                      className="font-mono w-24"
                      data-testid="settings-leaf-concurrency"
                      title={t.settings.leafConcurrencyHint}
                    />
                  </div>
                </div>
                <FieldDescription className="mt-2 text-xs">
                  {t.settings.planScoutCountHint} {t.settings.reviewCouncilSizeHint}{" "}
                  {t.settings.domainConcurrencyHint} {t.settings.leafConcurrencyHint}{" "}
                  {t.settings.maxLeafFanOutHint}
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>{t.settings.roleModelsTitle}</FieldLabel>
                <FieldDescription>{t.settings.roleModelsHint}</FieldDescription>
                <div className="mt-2 flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{t.settings.rolePlanner}</span>
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
                    <span className="text-xs text-muted-foreground">{t.settings.roleWorker}</span>
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
                    <span className="text-xs text-muted-foreground">{t.settings.roleWriter}</span>
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
  );
}
