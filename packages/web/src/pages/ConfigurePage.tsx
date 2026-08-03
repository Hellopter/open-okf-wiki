/**
 * Workspace configure surface — one flat section row (Sources · General ·
 * Skill · Danger) under a single route. Hash keeps deep links stable:
 * #sources | #general (also reads #models) | #skill | #danger.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  deleteWorkspace,
  getWorkspace,
  getWorkspaceSkill,
  readWorkspaceSkillFile,
  type SkillInfo,
  type WorkspaceConfig,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { formatMessage, useI18n } from "../i18n";
import { notifyError } from "../lib/notify";
import { WorkbenchShell } from "../shells/WorkbenchShell";
import { DangerSection } from "./configure/DangerSection";
import { GeneralSection } from "./configure/GeneralSection";
import { SkillSection } from "./configure/SkillSection";
import { SourcesSection } from "./configure/SourcesSection";
import { useWorkspaceGeneralForm } from "./configure/useWorkspaceGeneralForm";

type Section = "sources" | "general" | "skill" | "danger";

/** Written hash for each section. general writes #general (not #models). */
const SECTION_HASH: Record<Section, string> = {
  sources: "sources",
  general: "general",
  skill: "skill",
  danger: "danger",
};

function sectionFromHash(hash: string): Section {
  const h = hash.replace(/^#/, "");
  if (h === "sources") return "sources";
  if (h === "skill" || h === "danger") return h;
  // models (legacy) | general | empty | anything else → general
  return "general";
}

type ConfigureBodyProps = {
  workspace: WorkspaceConfig;
  onWorkspaceChange: (workspace: WorkspaceConfig) => void;
  section: Section;
  onSectionChange: (section: Section) => void;
};

function ConfigureBody({
  workspace,
  onWorkspaceChange,
  section,
  onSectionChange,
}: ConfigureBodyProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { id = "" } = useParams<{ id: string }>();
  const form = useWorkspaceGeneralForm(workspace, onWorkspaceChange);

  const [skill, setSkill] = useState<SkillInfo | null>(null);
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillFilePath, setSkillFilePath] = useState("SKILL.md");
  const [skillFileContent, setSkillFileContent] = useState("");
  const [skillFileDirty, setSkillFileDirty] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMeta, setDeleteMeta] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const loadSkill = useCallback(async (ws: WorkspaceConfig) => {
    try {
      const data = await getWorkspaceSkill(ws.id);
      setSkill(data.skill);
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
    } catch {
      setSkill(null);
    }
  }, []);

  useEffect(() => {
    void loadSkill(workspace);
  }, [workspace.id, loadSkill]);

  async function handleDeleteWorkspace() {
    if (!id) {
      return;
    }
    const deleteFiles = deleteMeta;
    setDeleting(true);
    try {
      await deleteWorkspace(id, {
        deleteFiles,
        expectedRevision: workspace.revision,
      });
      navigate("/workspaces");
    } catch (err) {
      notifyError(err);
    } finally {
      setDeleting(false);
    }
  }

  // Match global SettingsPage visual: AppShell-like page padding, title block,
  // line tabs, and full-width tab panels. Workbench top bar stays outside.
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:p-6 lg:p-8"
      data-testid="configure-settings-body"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t.settings.title}</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {t.settings.descriptionPrefix}{" "}
              <Link to="/settings" className="underline underline-offset-3 hover:text-foreground">
                {t.settings.descriptionLink}
              </Link>
              {t.settings.descriptionSuffix}
            </p>
          </div>
        </header>

        <Tabs
          value={section}
          onValueChange={(v) => {
            const next = v as Section;
            onSectionChange(next);
            navigate(
              {
                pathname: location.pathname,
                search: location.search,
                hash: SECTION_HASH[next],
              },
              { replace: true },
            );
          }}
          className="w-full"
        >
          <TabsList variant="line" className="mb-2 w-full justify-start">
            <TabsTrigger value="sources" data-testid="workspace-subnav-sources">
              {t.sources.title}
            </TabsTrigger>
            <TabsTrigger value="general" data-testid="settings-tab-general">
              {t.settings.tabGeneral}
            </TabsTrigger>
            <TabsTrigger value="skill" data-testid="settings-tab-skill">
              {t.settings.tabSkill}
            </TabsTrigger>
            <TabsTrigger value="danger" data-testid="settings-tab-danger">
              {t.settings.tabDanger}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sources" className="flex flex-col gap-4 outline-none" keepMounted>
            <SourcesSection
              workspace={workspace}
              onWorkspaceChange={onWorkspaceChange}
              skipNextWorkspaceHydrate={form.skipNextWorkspaceHydrate}
            />
          </TabsContent>

          <TabsContent
            value="general"
            className="flex flex-col gap-4 outline-none"
            data-testid="settings-page"
            keepMounted
          >
            <ErrorBanner error={form.loadError} onDismiss={() => form.setLoadError(null)} />
            {form.loading ? (
              <LoadingState label={t.settings.loading} />
            ) : (
              <GeneralSection
                workspace={workspace}
                models={form.models}
                defaultModelProfileId={form.defaultModelProfileId}
                isSubmitting={form.isSubmitting}
                isDirty={form.isDirty}
                onSubmit={form.handleSubmit}
                fieldErrors={form.fieldErrors}
                onClearFieldError={form.clearFieldError}
                name={form.name}
                setName={form.setName}
                modelProfileId={form.modelProfileId}
                setModelProfileId={form.setModelProfileId}
                publicationPath={form.publicationPath}
                setPublicationPath={form.setPublicationPath}
                planConfirm={form.planConfirm}
                setPlanConfirm={form.setPlanConfirm}
                wikiLanguage={form.wikiLanguage}
                setWikiLanguage={form.setWikiLanguage}
                contextTargetTokens={form.contextTargetTokens}
                setContextTargetTokens={form.setContextTargetTokens}
                requestTimeoutSeconds={form.requestTimeoutSeconds}
                setRequestTimeoutSeconds={form.setRequestTimeoutSeconds}
                gateTimeoutSeconds={form.gateTimeoutSeconds}
                setGateTimeoutSeconds={form.setGateTimeoutSeconds}
                retryEnabled={form.retryEnabled}
                setRetryEnabled={form.setRetryEnabled}
                retryMaxRetries={form.retryMaxRetries}
                setRetryMaxRetries={form.setRetryMaxRetries}
                retryBaseDelayMs={form.retryBaseDelayMs}
                setRetryBaseDelayMs={form.setRetryBaseDelayMs}
                providerMaxRetries={form.providerMaxRetries}
                setProviderMaxRetries={form.setProviderMaxRetries}
                providerMaxRetryDelayMs={form.providerMaxRetryDelayMs}
                setProviderMaxRetryDelayMs={form.setProviderMaxRetryDelayMs}
                maxDomainFanOut={form.maxDomainFanOut}
                setMaxDomainFanOut={form.setMaxDomainFanOut}
                maxLeafFanOut={form.maxLeafFanOut}
                setMaxLeafFanOut={form.setMaxLeafFanOut}
                maxActiveRuns={form.maxActiveRuns}
                setMaxActiveRuns={form.setMaxActiveRuns}
                maxConcurrentAttempts={form.maxConcurrentAttempts}
                setMaxConcurrentAttempts={form.setMaxConcurrentAttempts}
                planScoutMode={form.planScoutMode}
                setPlanScoutMode={form.setPlanScoutMode}
                planScoutCount={form.planScoutCount}
                setPlanScoutCount={form.setPlanScoutCount}
                planScoutConcurrency={form.planScoutConcurrency}
                setPlanScoutConcurrency={form.setPlanScoutConcurrency}
                planSurveyTaskBudget={form.planSurveyTaskBudget}
                setPlanSurveyTaskBudget={form.setPlanSurveyTaskBudget}
                planRescoutMaxRounds={form.planRescoutMaxRounds}
                setPlanRescoutMaxRounds={form.setPlanRescoutMaxRounds}
                requireSourceCoverage={form.requireSourceCoverage}
                setRequireSourceCoverage={form.setRequireSourceCoverage}
                requireSurfaceCoverage={form.requireSurfaceCoverage}
                setRequireSurfaceCoverage={form.setRequireSurfaceCoverage}
                maxSourcesPerRun={form.maxSourcesPerRun}
                setMaxSourcesPerRun={form.setMaxSourcesPerRun}
                maxSurfacesRequired={form.maxSurfacesRequired}
                setMaxSurfacesRequired={form.setMaxSurfacesRequired}
                reviewCouncilSize={form.reviewCouncilSize}
                setReviewCouncilSize={form.setReviewCouncilSize}
                reviewConcurrency={form.reviewConcurrency}
                setReviewConcurrency={form.setReviewConcurrency}
                domainConcurrency={form.domainConcurrency}
                setDomainConcurrency={form.setDomainConcurrency}
                leafConcurrency={form.leafConcurrency}
                setLeafConcurrency={form.setLeafConcurrency}
                plannerProfileId={form.plannerProfileId}
                setPlannerProfileId={form.setPlannerProfileId}
                workerProfileId={form.workerProfileId}
                setWorkerProfileId={form.setWorkerProfileId}
                writerProfileId={form.writerProfileId}
                setWriterProfileId={form.setWriterProfileId}
              />
            )}
          </TabsContent>

          <TabsContent value="skill" className="flex flex-col gap-4 outline-none" keepMounted>
            {form.loading ? (
              <LoadingState label={t.settings.loading} />
            ) : (
              <SkillSection
                workspaceId={id}
                expectedRevision={workspace.revision}
                models={form.models}
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
                onWorkspaceChange={onWorkspaceChange}
                applyWorkspace={form.applyWorkspace}
                skipNextWorkspaceHydrate={form.skipNextWorkspaceHydrate}
              />
            )}
          </TabsContent>

          <TabsContent value="danger" className="flex flex-col gap-4 outline-none" keepMounted>
            <DangerSection
              deleting={deleting}
              onRequestDelete={() => {
                setDeleteMeta(false);
                setDeleteDialogOpen(true);
              }}
            />
          </TabsContent>
        </Tabs>
      </div>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setDeleteMeta(false);
          }
        }}
        title={t.settings.deleteConfirmTitle}
        description={formatMessage(t.settings.deleteConfirm, {
          name: workspace.name,
        })}
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

export function ConfigurePage() {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const location = useLocation();
  const [workspace, setWorkspace] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [section, setSection] = useState<Section>(() => sectionFromHash(location.hash));

  useEffect(() => {
    setSection(sectionFromHash(location.hash));
  }, [location.hash]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getWorkspace(id);
        if (!cancelled) setWorkspace(data.workspace);
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setWorkspace(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <WorkbenchShell
      workspaceId={id}
      workspaceName={workspace?.name}
      mode="configure"
      immersive
      error={error}
      onDismissError={() => setError(null)}
      testId="configure-page"
    >
      {loading ? (
        <div className="flex min-h-0 flex-1 flex-col p-4 md:p-6">
          <LoadingState label={t.common.loading} />
        </div>
      ) : workspace ? (
        <ConfigureBody
          workspace={workspace}
          onWorkspaceChange={setWorkspace}
          section={section}
          onSectionChange={setSection}
        />
      ) : null}
    </WorkbenchShell>
  );
}
