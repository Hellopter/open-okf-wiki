import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  /** Parent workspace setter for successful local mutations (with skip). */
  onWorkspaceChange: (workspace: WorkspaceConfig) => void;
  /**
   * Full form rehydrate + parent update. Use on revision conflict so general
   * form picks up the server workspace; do not pair with skip.
   */
  applyWorkspace: (ws: WorkspaceConfig, catalog: ModelProfilePublic[]) => void;
  /**
   * Call before successful onWorkspaceChange so the general form does not
   * rehydrate/flash loading over dirty edits.
   */
  skipNextWorkspaceHydrate?: (workspaceId: string) => void;
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
  onWorkspaceChange,
  applyWorkspace,
  skipNextWorkspaceHydrate,
}: SkillSectionProps) {
  const { t } = useI18n();

  return (
    <Card className="w-full max-w-3xl" data-testid="settings-skill-panel">
      <CardHeader>
        <CardTitle>{t.settings.skillTitle}</CardTitle>
        <CardDescription>{t.settings.skillDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {skill ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
            <dt className="text-muted-foreground">{t.settings.skillKind}</dt>
            <dd data-testid="settings-skill-kind">{skill.kind}</dd>
            <dt className="text-muted-foreground">{t.settings.skillDigest}</dt>
            <dd className="font-mono text-xs" data-testid="settings-skill-digest">
              {skill.digest.slice(0, 16)}…
            </dd>
            <dt className="text-muted-foreground">{t.settings.skillPath}</dt>
            <dd className="font-mono text-xs break-all whitespace-normal">{skill.path}</dd>
            {skill.name ? (
              <>
                <dt className="text-muted-foreground">{t.settings.skillName}</dt>
                <dd>{skill.name}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t.settings.skillUnavailable}</p>
        )}
        <div className="flex flex-wrap gap-2">
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
                  skipNextWorkspaceHydrate?.(result.workspace.id);
                  onWorkspaceChange(result.workspace);
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
                  skipNextWorkspaceHydrate?.(result.workspace.id);
                  onWorkspaceChange(result.workspace);
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
                  skipNextWorkspaceHydrate?.(result.workspace.id);
                  onWorkspaceChange(result.workspace);
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
              <FieldLabel htmlFor="settings-skill-file-path">{t.settings.skillFileLabel}</FieldLabel>
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
            <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
              <span>{t.settings.skillFiles}</span>
              <Button
                type="button"
                variant="link"
                className="h-auto px-0"
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
              </Button>
              {skill.files.length > 0
                ? ` · ${skill.files.slice(0, 8).join(", ")}${skill.files.length > 8 ? "…" : ""}`
                : null}
            </p>
          </FieldGroup>
        ) : null}
      </CardContent>
    </Card>
  );
}
