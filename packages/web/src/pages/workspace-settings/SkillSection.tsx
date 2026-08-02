import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  createWorkspaceSkillFork,
  listWorkspaceSkillFiles,
  type ModelProfilePublic,
  readWorkspaceSkillFile,
  resetWorkspaceSkill,
  type SkillInfo,
  type WorkspaceConfig,
  workspaceFromRevisionConflict,
  writeWorkspaceSkillFile,
} from "../../api";
import { useI18n } from "../../i18n";
import { notifyError, notifySuccess } from "../../lib/notify";

export type SkillSectionProps = {
  workspaceId: string;
  expectedRevision: number;
  models: ModelProfilePublic[];
  skill: SkillInfo | null;
  skillBusy: boolean;
  skillFilePath: string;
  skillFileContent: string;
  skillFileDirty: boolean;
  setSkill: (skill: SkillInfo | null) => void;
  setSkillBusy: (busy: boolean) => void;
  setSkillFilePath: (path: string) => void;
  setSkillFileContent: (content: string) => void;
  setSkillFileDirty: (dirty: boolean) => void;
  applyWorkspace: (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => void;
};

export function SkillSection({
  workspaceId,
  expectedRevision,
  models,
  skill,
  skillBusy,
  skillFilePath,
  skillFileContent,
  skillFileDirty,
  setSkill,
  setSkillBusy,
  setSkillFilePath,
  setSkillFileContent,
  setSkillFileDirty,
  applyWorkspace,
}: SkillSectionProps) {
  const { t } = useI18n();

  return (
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
                  if (!workspaceId) {
                    return;
                  }
                  setSkillBusy(true);
                  try {
                    const result = await createWorkspaceSkillFork(workspaceId, expectedRevision);
                    applyWorkspace(result.workspace, models);
                    setSkill(result.skill);
                    const file = await readWorkspaceSkillFile(workspaceId, "SKILL.md");
                    setSkillFilePath("SKILL.md");
                    setSkillFileContent(file.file.content);
                    setSkillFileDirty(false);
                    notifySuccess(t.settings.skillForked);
                  } catch (err) {
                    const latest = workspaceFromRevisionConflict(err);
                    if (latest) applyWorkspace(latest, models);
                    notifyError(err);
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
                  if (!workspaceId) {
                    return;
                  }
                  setSkillBusy(true);
                  try {
                    const result = await resetWorkspaceSkill(workspaceId, expectedRevision);
                    applyWorkspace(result.workspace, models);
                    setSkill(result.skill);
                    setSkillFileContent("");
                    setSkillFileDirty(false);
                  } catch (err) {
                    const latest = workspaceFromRevisionConflict(err);
                    if (latest) applyWorkspace(latest, models);
                    notifyError(err);
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
                  if (!workspaceId || !skillFilePath.trim()) {
                    return;
                  }
                  setSkillBusy(true);
                  try {
                    const file = await readWorkspaceSkillFile(workspaceId, skillFilePath.trim());
                    setSkillFileContent(file.file.content);
                    setSkillFileDirty(false);
                  } catch (err) {
                    const latest = workspaceFromRevisionConflict(err);
                    if (latest) applyWorkspace(latest, models);
                    notifyError(err);
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
                skillBusy || skill?.kind !== "fork" || !skillFileDirty || !skillFilePath.trim()
              }
              data-testid="settings-skill-save-file"
              onClick={() => {
                void (async () => {
                  if (!workspaceId) {
                    return;
                  }
                  setSkillBusy(true);
                  try {
                    const result = await writeWorkspaceSkillFile(workspaceId, {
                      expectedRevision,
                      path: skillFilePath.trim(),
                      content: skillFileContent,
                    });
                    applyWorkspace(result.workspace, models);
                    setSkill(result.skill);
                    setSkillFileDirty(false);
                    notifySuccess(t.settings.skillSaved);
                  } catch (err) {
                    const latest = workspaceFromRevisionConflict(err);
                    if (latest) applyWorkspace(latest, models);
                    notifyError(err);
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
                      if (!workspaceId) {
                        return;
                      }
                      try {
                        const listed = await listWorkspaceSkillFiles(workspaceId, "");
                        const firstMd = listed.entries.find(
                          (e) => e.kind === "file" && e.path.endsWith(".md"),
                        );
                        if (firstMd) {
                          setSkillFilePath(firstMd.path);
                        }
                      } catch (err) {
                        notifyError(err);
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
  );
}
