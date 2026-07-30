import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import type { AppSettingsPublic } from "../../api";
import { useI18n } from "../../i18n";

export type AppSettingsPanelProps = {
  appSettings: AppSettingsPublic | null;
  skillsSaving: boolean;
  onToggleHomeSkills: (next: boolean) => void;
};

export function AppSettingsPanel({
  appSettings,
  skillsSaving,
  onToggleHomeSkills,
}: AppSettingsPanelProps) {
  const { t } = useI18n();

  return (
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
                <FieldDescription>{t.globalSettings.loadHomeSkillsHint}</FieldDescription>
              </FieldContent>
              <Switch
                id="settings-load-home-skills"
                checked={appSettings.loadHomeSkills}
                disabled={skillsSaving}
                data-testid="settings-load-home-skills"
                onCheckedChange={(checked) => {
                  void onToggleHomeSkills(checked);
                }}
              />
            </Field>
            <dl className="kv">
              <div>
                <dt>{t.globalSettings.homeSkillsPath}</dt>
                <dd className="mono small whitespace-normal">{appSettings.homeSkillsDir}</dd>
              </div>
              <div>
                <dt>{t.globalSettings.workspaceSkillsPath}</dt>
                <dd className="mono small whitespace-normal">
                  {"{workspace}/"}
                  {appSettings.workspaceSkillsRelative}
                </dd>
              </div>
            </dl>
            {skillsSaving ? <p className="muted small">{t.globalSettings.skillsSaving}</p> : null}
          </>
        ) : (
          <p className="muted small">{t.globalSettings.appSettingsUnavailable}</p>
        )}
      </CardContent>
    </Card>
  );
}
