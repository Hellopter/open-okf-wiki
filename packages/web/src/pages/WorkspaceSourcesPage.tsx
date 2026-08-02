import { IGNORE_PRESETS } from "@okf-wiki/contract";
import { type FormEvent, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  addSource,
  cloneSource,
  deleteSource,
  type GitProbe,
  probeSources,
  type SourceProbeResult,
  updateSource,
  type WorkspaceConfig,
  type WorkspaceSource,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { formatMessage, useI18n } from "../i18n";
import { notifyError } from "../lib/notify";

type SourcesMessages = ReturnType<typeof useI18n>["t"]["sources"];

function probeLabel(probe: GitProbe | undefined, messages: SourcesMessages): string {
  if (!probe) {
    return "—";
  }
  if (!probe.isGit) {
    return probe.error
      ? formatMessage(messages.probeNotGitError, { error: probe.error })
      : messages.probeNotGit;
  }
  const parts = [
    probe.branch ?? messages.probeDetached,
    probe.head ? probe.head.slice(0, 8) : null,
    probe.dirty ? messages.probeDirty : messages.probeClean,
  ].filter(Boolean);
  return parts.join(" · ");
}

function patternsToText(patterns: readonly string[] | undefined): string {
  return (patterns ?? []).join("\n");
}

function textToPatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export type WorkspaceSourcesPageProps = {
  workspace: WorkspaceConfig;
  onWorkspaceChange: (workspace: WorkspaceConfig) => void;
};

export function WorkspaceSourcesPage({ workspace, onWorkspaceChange }: WorkspaceSourcesPageProps) {
  const { t } = useI18n();
  const { id = "" } = useParams<{ id: string }>();
  const [path, setPath] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [cloneId, setCloneId] = useState("");
  const [cloneRef, setCloneRef] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [probing, setProbing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, GitProbe>>({});
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editApplyDefaults, setEditApplyDefaults] = useState(true);
  const [editIgnoreText, setEditIgnoreText] = useState("");
  const [savingIgnores, setSavingIgnores] = useState(false);

  function openIgnoreEditor(source: WorkspaceSource) {
    setEditingSourceId(source.id);
    setEditApplyDefaults(source.applyDefaultIgnores !== false);
    setEditIgnoreText(patternsToText(source.ignore));
  }

  function applyPreset(presetId: string) {
    const preset = IGNORE_PRESETS[presetId];
    if (!preset) {
      return;
    }
    const existing = new Set(textToPatterns(editIgnoreText));
    for (const pattern of preset.patterns) {
      existing.add(pattern);
    }
    setEditIgnoreText([...existing].join("\n"));
  }

  async function handleSaveIgnores() {
    if (!id || !editingSourceId) {
      return;
    }
    setSavingIgnores(true);
    try {
      const result = await updateSource(id, editingSourceId, {
        applyDefaultIgnores: editApplyDefaults,
        ignore: textToPatterns(editIgnoreText),
      });
      onWorkspaceChange(result.workspace);
      setEditingSourceId(null);
    } catch (err) {
      notifyError(err);
    } finally {
      setSavingIgnores(false);
    }
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!id || !path.trim()) {
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await addSource(id, {
        path: path.trim(),
        id: sourceId.trim() || undefined,
      });
      onWorkspaceChange(result.workspace);
      setProbes((prev) => ({ ...prev, [result.source.id]: result.probe }));
      setPath("");
      setSourceId("");
    } catch (err) {
      notifyError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleClone(event: FormEvent) {
    event.preventDefault();
    if (!id || !remoteUrl.trim()) {
      return;
    }
    setIsPending(true);
    try {
      const result = await cloneSource(id, {
        remoteUrl: remoteUrl.trim(),
        id: cloneId.trim() || undefined,
        ref: cloneRef.trim() || undefined,
      });
      onWorkspaceChange(result.workspace);
      setProbes((prev) => ({ ...prev, [result.source.id]: result.probe }));
      setRemoteUrl("");
      setCloneId("");
      setCloneRef("");
    } catch (err) {
      notifyError(err);
    } finally {
      setIsPending(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!id || !deleteTargetId) {
      return;
    }
    const sourceIdToDelete = deleteTargetId;
    setDeletingId(sourceIdToDelete);
    try {
      const result = await deleteSource(id, sourceIdToDelete);
      onWorkspaceChange(result.workspace);
      setProbes((prev) => {
        const next = { ...prev };
        delete next[sourceIdToDelete];
        return next;
      });
      if (editingSourceId === sourceIdToDelete) {
        setEditingSourceId(null);
      }
    } catch (err) {
      notifyError(err);
    } finally {
      setDeletingId(null);
    }
  }

  async function handleProbeAll() {
    if (!id) {
      return;
    }
    setProbing(true);
    try {
      const result = await probeSources(id);
      const map: Record<string, GitProbe> = {};
      for (const item of result.probes as SourceProbeResult[]) {
        map[item.sourceId] = item.probe;
      }
      setProbes(map);
    } catch (err) {
      notifyError(err);
    } finally {
      setProbing(false);
    }
  }

  function ignoreSummary(source: WorkspaceSource): string {
    const defaults =
      source.applyDefaultIgnores !== false ? t.sources.defaultsOn : t.sources.defaultsOff;
    const custom = formatMessage(t.sources.customCount, {
      n: source.ignore?.length ?? 0,
    });
    return `${defaults} · ${custom}`;
  }

  return (
    <div data-testid="sources-page" className="flex flex-col gap-5">
      <ConfirmDialog
        open={deleteTargetId != null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTargetId(null);
          }
        }}
        title={t.sources.deleteConfirmTitle}
        description={
          deleteTargetId
            ? formatMessage(t.sources.deleteConfirmBody, { id: deleteTargetId })
            : undefined
        }
        confirmLabel={deletingId != null ? t.sources.removing : t.sources.deleteSubmit}
        cancelLabel={t.common.cancel}
        onConfirm={() => void handleDeleteConfirm()}
        confirmDisabled={deletingId != null}
        data-testid="source-delete-dialog"
        confirmTestId="source-delete-confirm"
      />

      <>
        <Card>
          <CardHeader className="row-between items-center">
            <CardTitle>{t.sources.registered}</CardTitle>
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleProbeAll()}
              disabled={probing || workspace.sources.length === 0}
              data-testid="source-probe-all"
            >
              {probing ? t.sources.probing : t.sources.probeAll}
            </Button>
          </CardHeader>
          <CardContent>
            {workspace.sources.length === 0 ? (
              <Empty className="border-0 p-6">
                <EmptyHeader>
                  <EmptyTitle className="text-base">{t.sources.empty}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table data-testid="source-list">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.sources.colId}</TableHead>
                    <TableHead>{t.sources.colOrigin}</TableHead>
                    <TableHead>{t.sources.colPath}</TableHead>
                    <TableHead>{t.sources.colProbe}</TableHead>
                    <TableHead>{t.sources.colIgnores}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t.common.actions}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {workspace.sources.map((source) => (
                    <TableRow key={source.id} data-source-id={source.id}>
                      <TableCell className="mono">{source.id}</TableCell>
                      <TableCell className="muted small">
                        {source.origin.type === "clone"
                          ? `${t.sources.originClone} · ${source.origin.remoteUrl}`
                          : t.sources.originPath}
                      </TableCell>
                      <TableCell className="mono whitespace-normal">{source.path}</TableCell>
                      <TableCell className="muted small whitespace-normal">
                        {probeLabel(probes[source.id], t.sources)}
                      </TableCell>
                      <TableCell className="muted small whitespace-normal">
                        {ignoreSummary(source)}
                      </TableCell>
                      <TableCell className="actions-cell">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            data-testid={`source-edit-ignores-${source.id}`}
                            onClick={() => openIgnoreEditor(source)}
                          >
                            {t.sources.editIgnores}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={deletingId === source.id}
                            onClick={() => setDeleteTargetId(source.id)}
                            data-testid={`source-delete-${source.id}`}
                          >
                            {deletingId === source.id ? <Spinner data-icon="inline-start" /> : null}
                            {deletingId === source.id ? t.sources.removing : t.sources.delete}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Sheet
          open={editingSourceId != null}
          onOpenChange={(open) => {
            if (!open) {
              setEditingSourceId(null);
            }
          }}
        >
          <SheetContent
            side="right"
            className="w-full sm:max-w-lg"
            data-testid="source-ignore-editor"
          >
            <SheetHeader>
              <SheetTitle>
                {t.sources.ignoreTitle}: <code className="mono">{editingSourceId}</code>
              </SheetTitle>
              <SheetDescription>{t.sources.ignoreDescription}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="source-apply-defaults">
                      {t.sources.applyDefaults}
                    </FieldLabel>
                  </FieldContent>
                  <Switch
                    id="source-apply-defaults"
                    checked={editApplyDefaults}
                    onCheckedChange={setEditApplyDefaults}
                    data-testid="source-apply-defaults"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-ignore-text">{t.sources.ignorePatterns}</FieldLabel>
                  <Textarea
                    id="source-ignore-text"
                    className="min-h-32 font-mono text-sm"
                    value={editIgnoreText}
                    onChange={(e) => setEditIgnoreText(e.target.value)}
                    placeholder={t.sources.ignorePlaceholder}
                    spellCheck={false}
                    data-testid="source-ignore-text"
                  />
                </Field>
              </FieldGroup>
              <div className="flex flex-wrap items-center gap-2">
                <span className="muted small">{t.sources.presets}:</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="preset-java-tests"
                  onClick={() => applyPreset("java-tests")}
                >
                  {t.sources.presetJava}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="preset-js-tests"
                  onClick={() => applyPreset("js-tests")}
                >
                  {t.sources.presetJs}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="preset-python-tests"
                  onClick={() => applyPreset("python-tests")}
                >
                  {t.sources.presetPython}
                </Button>
              </div>
            </div>
            <SheetFooter>
              <Button type="button" variant="outline" onClick={() => setEditingSourceId(null)}>
                {t.sources.closeEditor}
              </Button>
              <Button
                type="button"
                disabled={savingIgnores}
                onClick={() => void handleSaveIgnores()}
                data-testid="source-ignore-save"
              >
                {savingIgnores ? t.sources.savingIgnores : t.sources.saveIgnores}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <Card>
          <CardHeader>
            <CardTitle>{t.sources.linkTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="max-w-xl" onSubmit={(e) => void handleAdd(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="source-path">{t.sources.pathLabel}</FieldLabel>
                  <Input
                    id="source-path"
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder={t.sources.pathPlaceholder}
                    required
                    className="font-mono"
                    data-testid="source-path-input"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-id">
                    {t.sources.sourceIdLabel}{" "}
                    <span className="muted font-normal">{t.sources.sourceIdOptional}</span>
                  </FieldLabel>
                  <Input
                    id="source-id"
                    type="text"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    placeholder={t.sources.sourceIdPlaceholder}
                    pattern="[a-z][a-z0-9-]{0,62}"
                    className="font-mono"
                    data-testid="source-id-input"
                  />
                  <FieldDescription>{t.sources.sourceIdHint}</FieldDescription>
                </Field>
                <div className="form-actions">
                  <Button
                    type="submit"
                    disabled={isSubmitting || !path.trim()}
                    data-testid="source-add-submit"
                  >
                    {isSubmitting ? (
                      <>
                        <Spinner data-icon="inline-start" />
                        {t.sources.adding}
                      </>
                    ) : (
                      t.sources.addSource
                    )}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.sources.cloneTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="muted small mb-4">
              {formatMessage(t.sources.cloneHint, { root: workspace.rootPath })}
            </p>
            <form className="max-w-xl" onSubmit={(e) => void handleClone(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="source-remote">{t.sources.remoteUrl}</FieldLabel>
                  <Input
                    id="source-remote"
                    type="text"
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    required
                    className="font-mono"
                    data-testid="source-remote-input"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-clone-id">{t.sources.cloneId}</FieldLabel>
                  <Input
                    id="source-clone-id"
                    type="text"
                    value={cloneId}
                    onChange={(e) => setCloneId(e.target.value)}
                    placeholder="repo"
                    pattern="[a-z][a-z0-9-]{0,62}"
                    className="font-mono"
                    data-testid="source-clone-id-input"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="source-clone-ref">{t.sources.cloneRef}</FieldLabel>
                  <Input
                    id="source-clone-ref"
                    type="text"
                    value={cloneRef}
                    onChange={(e) => setCloneRef(e.target.value)}
                    placeholder="main"
                    className="font-mono"
                    data-testid="source-clone-ref-input"
                  />
                </Field>
                <div className="form-actions">
                  <Button
                    type="submit"
                    disabled={isPending || !remoteUrl.trim()}
                    data-testid="source-clone-submit"
                  >
                    {isPending && <Spinner data-icon="inline-start" />}
                    {isPending && t.sources.cloning}
                    {!isPending && t.sources.cloneSubmit}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </>
    </div>
  );
}
