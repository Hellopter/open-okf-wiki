/**
 * Workspace configure surface — one flat section row (Sources · General ·
 * Skill · Danger) under a single route. Hash keeps deep links stable:
 * #sources | #models (general) | #skill | #danger.
 */

import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getWorkspace, type WorkspaceConfig } from "../api";
import { LoadingState } from "../components/LoadingState";
import { useI18n } from "../i18n";
import { WorkbenchShell } from "../shells/WorkbenchShell";
import { type SettingsSection, WorkspaceSettingsPage } from "./WorkspaceSettingsPage";
import { WorkspaceSourcesPage } from "./WorkspaceSourcesPage";

type Section = "sources" | SettingsSection;

const SECTION_HASH: Record<Section, string> = {
  sources: "sources",
  general: "models",
  skill: "skill",
  danger: "danger",
};

function sectionFromHash(hash: string): Section {
  const h = hash.replace(/^#/, "");
  if (h === "sources") return "sources";
  if (h === "skill" || h === "danger") return h;
  // models | general | anything else → general settings
  return "general";
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
      error={error}
      onDismissError={() => setError(null)}
      testId="configure-page"
    >
      {loading ? (
        <LoadingState label={t.common.loading} />
      ) : workspace ? (
        <div className="flex w-full flex-col gap-4">
          <Tabs
            value={section}
            onValueChange={(v) => {
              const next = v as Section;
              setSection(next);
              window.history.replaceState(null, "", `#${SECTION_HASH[next]}`);
            }}
          >
            <TabsList variant="line" className="justify-start">
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
          </Tabs>
          {section === "sources" ? (
            <WorkspaceSourcesPage workspace={workspace} onWorkspaceChange={setWorkspace} />
          ) : (
            <WorkspaceSettingsPage
              workspace={workspace}
              onWorkspaceChange={setWorkspace}
              section={section}
            />
          )}
        </div>
      ) : null}
    </WorkbenchShell>
  );
}
