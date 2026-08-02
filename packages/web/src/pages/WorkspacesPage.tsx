import { EllipsisVertical } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  createWorkspace,
  deleteWorkspace,
  getProvider,
  listWorkspaces,
  type ModelProfilePublic,
  type WorkspaceSummary,
} from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner } from "../components/ErrorBanner";
import { LoadingState } from "../components/LoadingState";
import { ModelSelect } from "../components/ModelSelect";
import { formatMessage, useI18n } from "../i18n";
import { notifyError } from "../lib/notify";
import { operateHref } from "../lib/workspace-path";
import { AppShell } from "../shells/AppShell";

export function WorkspacesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [models, setModels] = useState<ModelProfilePublic[]>([]);
  const [defaultModelProfileId, setDefaultModelProfileId] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [modelProfileId, setModelProfileId] = useState("");
  const [maxActiveRuns, setMaxActiveRuns] = useState("");
  const [maxConcurrentAttempts, setMaxConcurrentAttempts] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceSummary | null>(null);
  const [deleteMeta, setDeleteMeta] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [wsData, providerData] = await Promise.all([
        listWorkspaces(),
        getProvider().catch(() => null),
      ]);
      setWorkspaces(wsData.workspaces);
      const catalog = providerData?.provider;
      const catalogModels = catalog?.models ?? [];
      setModels(catalogModels);
      setDefaultModelProfileId(catalog?.defaultModelProfileId);
      const preferred =
        catalog?.defaultModelProfileId &&
        catalogModels.some((m) => m.id === catalog.defaultModelProfileId)
          ? catalog.defaultModelProfileId
          : (catalogModels[0]?.id ?? "");
      setModelProfileId((prev) => prev || preferred);
    } catch (err) {
      setLoadError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreateForm() {
    setShowForm(true);
  }

  function closeCreateForm() {
    setShowForm(false);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      const root = rootPath.trim();
      const activeRuns = Number(maxActiveRuns);
      const concurrentAttempts = Number(maxConcurrentAttempts);
      const { workspace } = await createWorkspace({
        name: name.trim(),
        rootPath: root,
        ...(modelProfileId ? { modelProfileId } : {}),
        orchestration: { maxActiveRuns: activeRuns, maxConcurrentAttempts: concurrentAttempts },
      });
      setName("");
      setRootPath("");
      setMaxActiveRuns("");
      setMaxConcurrentAttempts("");
      setShowForm(false);
      navigate(operateHref(workspace.id));
    } catch (err) {
      notifyError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) {
      return;
    }
    // Capture before dialog close clears controlled state.
    const target = deleteTarget;
    const deleteFiles = deleteMeta;
    setDeletingId(target.id);
    try {
      await deleteWorkspace(target.id, {
        deleteFiles,
        expectedRevision: target.revision,
      });
      await load();
    } catch (err) {
      notifyError(err);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <AppShell>
      <div data-testid="workspaces-page" className="flex flex-col gap-5">
        <header className="page-header row-between">
          <div>
            <h1>{t.workspaces.title}</h1>
            <p>
              {t.workspaces.descriptionBefore}
              <Link to="/settings">{t.workspaces.settingsLink}</Link>
              {t.workspaces.descriptionAfter}
            </p>
          </div>
          <Button type="button" onClick={openCreateForm}>
            {t.workspaces.create}
          </Button>
        </header>

        <ErrorBanner error={loadError} onDismiss={() => setLoadError(null)} />

        <Dialog
          open={showForm}
          onOpenChange={(open) => {
            if (open) {
              openCreateForm();
            } else {
              closeCreateForm();
            }
          }}
        >
          <DialogContent className="sm:max-w-lg" data-testid="workspace-create-form">
            <DialogHeader>
              <DialogTitle>{t.workspaces.createTitle}</DialogTitle>
              <DialogDescription>{t.workspaces.rootHint}</DialogDescription>
            </DialogHeader>
            <form onSubmit={(e) => void handleCreate(e)}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="workspace-name">{t.workspaces.nameLabel}</FieldLabel>
                  <Input
                    id="workspace-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.workspaces.namePlaceholder}
                    required
                    maxLength={120}
                    autoFocus
                    data-testid="workspace-name-input"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="workspace-root">{t.workspaces.rootLabel}</FieldLabel>
                  <Input
                    id="workspace-root"
                    type="text"
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    placeholder={t.workspaces.rootPlaceholder}
                    required
                    className="font-mono"
                    data-testid="workspace-root-input"
                  />
                  <FieldDescription>{t.workspaces.rootHint}</FieldDescription>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel htmlFor="workspace-max-active-runs">Active Runs</FieldLabel>
                    <Input
                      id="workspace-max-active-runs"
                      type="number"
                      min="1"
                      max="32"
                      value={maxActiveRuns}
                      onChange={(event) => setMaxActiveRuns(event.target.value)}
                      required
                      data-testid="workspace-max-active-runs-input"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="workspace-max-concurrent-attempts">
                      Concurrent attempts
                    </FieldLabel>
                    <Input
                      id="workspace-max-concurrent-attempts"
                      type="number"
                      min="1"
                      max="128"
                      value={maxConcurrentAttempts}
                      onChange={(event) => setMaxConcurrentAttempts(event.target.value)}
                      required
                      data-testid="workspace-max-concurrent-attempts-input"
                    />
                  </Field>
                </div>
                <ModelSelect
                  models={models}
                  value={modelProfileId}
                  onChange={setModelProfileId}
                  defaultModelProfileId={defaultModelProfileId}
                  required={models.length > 0}
                  allowEmpty={models.length === 0}
                />
              </FieldGroup>
              <DialogFooter className="mt-4 px-0 pb-0">
                <Button type="button" variant="outline" onClick={closeCreateForm}>
                  {t.workspaces.cancel}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    isSubmitting ||
                    !name.trim() ||
                    !rootPath.trim() ||
                    !Number.isInteger(Number(maxActiveRuns)) ||
                    Number(maxActiveRuns) < 1 ||
                    !Number.isInteger(Number(maxConcurrentAttempts)) ||
                    Number(maxConcurrentAttempts) < 1 ||
                    (models.length > 0 && !modelProfileId)
                  }
                  data-testid="workspace-create-submit"
                >
                  {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
                  {isSubmitting ? t.workspaces.creating : t.workspaces.createSubmit}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleteTarget != null}
          onOpenChange={(open) => {
            if (!open) {
              setDeleteTarget(null);
              setDeleteMeta(false);
            }
          }}
          title={t.workspaces.deleteConfirmTitle}
          description={
            deleteTarget
              ? formatMessage(t.workspaces.deleteConfirmBody, {
                  name: deleteTarget.name,
                })
              : undefined
          }
          confirmLabel={deletingId != null ? t.workspaces.deleting : t.workspaces.deleteSubmit}
          cancelLabel={t.common.cancel}
          onConfirm={() => void handleDeleteConfirm()}
          confirmDisabled={deletingId != null}
          data-testid="workspace-delete-dialog"
          confirmTestId="workspace-delete-confirm"
          metaChecked={deleteMeta}
          onMetaCheckedChange={setDeleteMeta}
          metaLabel={t.workspaces.deleteMetaLabel}
          metaTestId="workspace-delete-meta"
        />

        {loading ? (
          <LoadingState label={t.workspaces.loading} />
        ) : workspaces.length === 0 ? (
          <Card data-testid="workspaces-empty">
            <CardContent className="pt-0">
              <Empty className="border-0 p-6">
                <EmptyHeader>
                  <EmptyTitle className="text-base">{t.workspaces.emptyTitle}</EmptyTitle>
                  <EmptyDescription>{t.workspaces.emptyDescription}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <ul className="checklist text-left">
                    <li>
                      {t.workspaces.checklistModels}{" "}
                      <Link to="/settings">{t.workspaces.settingsLink}</Link>
                    </li>
                    <li>{t.workspaces.checklistSources}</li>
                    <li>{t.workspaces.checklistRun}</li>
                  </ul>
                  <Button type="button" onClick={openCreateForm}>
                    {t.workspaces.createSubmit}
                  </Button>
                </EmptyContent>
              </Empty>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="workspace-list">
            {workspaces.map((ws) => {
              const href = operateHref(ws.id);
              return (
                <Card
                  key={ws.id}
                  size="sm"
                  data-testid="workspace-row"
                  data-workspace-id={ws.id}
                  className="group relative transition-colors hover:ring-ring/40"
                >
                  <CardContent className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      {/* Stretched link: the whole card navigates; menu stays above it. */}
                      <Link
                        to={href}
                        className="row-link truncate text-sm after:absolute after:inset-0"
                        data-workspace-id={ws.id}
                      >
                        {ws.name}
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="relative z-10 -mt-1 -mr-1 shrink-0"
                              aria-label={t.workspaces.rowMenu}
                              data-testid="workspace-menu"
                            />
                          }
                        >
                          <EllipsisVertical />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              variant="destructive"
                              data-testid="workspace-delete"
                              disabled={deletingId === ws.id}
                              onClick={() => {
                                setDeleteTarget(ws);
                                setDeleteMeta(false);
                              }}
                            >
                              {t.workspaces.delete}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={ws.rootPath}
                    >
                      {ws.rootPath}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatMessage(t.workspaces.sourceCountLabel, { n: ws.sourceCount })}
                      {" · "}
                      {ws.lastOpenedAt ? new Date(ws.lastOpenedAt).toLocaleDateString() : "—"}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
