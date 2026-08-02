import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { redactErrorMessage } from "@okf-wiki/agent";
import {
  SourceAddSchema,
  SourceCloneSchema,
  SourceUpdateSchema,
  WorkspaceCreateSchema,
  WorkspacePatchRequestSchema,
  WorkspaceRevisionRequestSchema,
  WorkspaceRevisionSchema,
  WorkspaceSkillFileWriteSchema,
} from "@okf-wiki/contract";
import {
  acquireWikiRunsControlStoreLease,
  addSource,
  applyWorkspacePatch,
  assertNoWorkspaceActivityLeases,
  assertWorkspaceActive,
  beginWorkspaceDeletion,
  cloneIntoWorkspace,
  createSkillFork,
  createWorkspace,
  deleteWorkspaceMeta,
  getSkillInfo,
  listSkillDir,
  listWorkspaceSummaries,
  mutateWorkspace,
  probeLocalGit,
  readSkillFile,
  registerActiveWorkspaceInAppIndex,
  removeSource,
  removeWorkspaceFromAppIndex,
  resolveSkillSource,
  resolveWorkspaceModelSelection,
  saveWorkspace,
  skillForkDir,
  slugFromPath,
  uniqueSourceId,
  updateSource,
  WorkspaceIntakeError,
  WorkspaceRevisionConflictError,
  withWorkspaceRevision,
  writeWorkspaceSkillFile,
} from "@okf-wiki/core";
import { trySendCoreDomainError } from "../core-http-error.ts";
import { httpStatusForWorkspaceCode } from "../http-status.ts";
import { readJsonBody, sendCaughtError, sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import { getLogger } from "../logging/index.ts";
import {
  invalidateOperatorSessions,
  restoreOperatorSessionsAfterFailedWorkspaceDeletion,
  retireOperatorSessionsForDeletedWorkspace,
} from "../operator-sessions.ts";
import {
  closeWikiRunsForDeletedWorkspace,
  restoreWikiRunsAfterFailedWorkspaceDeletion,
} from "../wiki-runs-registry.ts";

function sendWorkspaceRevisionConflict(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof WorkspaceRevisionConflictError)) return false;
  sendError(res, 409, "workspace revision conflict", {
    code: error.code,
    expectedRevision: error.expectedRevision,
    workspace: error.current,
  });
  return true;
}

export async function handleListWorkspaces(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const workspaces = await listWorkspaceSummaries();
  sendJson(res, 200, { workspaces });
}

export async function handleCreateWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = WorkspaceCreateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid workspace create body", parsed.error.flatten());
    return;
  }
  const body = parsed.data;
  try {
    const model = await resolveWorkspaceModelSelection({
      modelProfileId: body.modelProfileId,
    });
    const workspace = await createWorkspace({
      name: body.name,
      rootPath: body.rootPath,
      publicationPath: body.publicationPath,
      modelProfileId: model.profileId,
      resolvedModelId: model.id,
      orchestration: body.orchestration,
    });
    await saveWorkspace(workspace);
    await registerActiveWorkspaceInAppIndex(workspace.rootPath);
    getLogger().info(
      {
        event: "workspace.create",
        workspaceId: workspace.id,
        rootPath: workspace.rootPath,
      },
      "workspace created",
    );
    sendJson(res, 201, { workspace });
  } catch (error) {
    getLogger().warn(
      { event: "workspace.create", err: redactErrorMessage(error) },
      "workspace create failed",
    );
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleGetWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  // Do not rewrite workspace.json for lastOpenedAt — only bump recents index.
  try {
    // A GET that started before DELETE must not restore the just-removed index entry.
    await assertWorkspaceActive(workspace.rootPath);
    await registerActiveWorkspaceInAppIndex(workspace.rootPath);
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    throw error;
  }
  sendJson(res, 200, { workspace });
}

export async function handlePatchWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  // Contract boundary: strict schema — unknown keys are rejected, not ignored.
  const parsed = WorkspacePatchRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid workspace patch body", parsed.error.flatten());
    return;
  }

  try {
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      (current) =>
        applyWorkspacePatch(current, parsed.data, {
          resolveModelSelection: async (profileId) =>
            resolveWorkspaceModelSelection({ modelProfileId: profileId }),
        }),
    );
    await registerActiveWorkspaceInAppIndex(next.rootPath);
    await invalidateOperatorSessions(next.id);
    getLogger().info({ event: "workspace.patch", workspaceId: next.id }, "workspace patched");
    sendJson(res, 200, { workspace: next });
  } catch (error) {
    getLogger().warn(
      { event: "workspace.patch", workspaceId: workspace.id, err: redactErrorMessage(error) },
      "workspace patch failed",
    );
    if (sendWorkspaceRevisionConflict(res, error)) return;
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleDeleteWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const rawRevision = url.searchParams.get("expectedRevision");
  const expectedRevision = WorkspaceRevisionSchema.safeParse(
    rawRevision !== null && /^\d+$/.test(rawRevision) ? Number(rawRevision) : undefined,
  );
  if (!expectedRevision.success) {
    sendError(res, 400, "expectedRevision query parameter is required");
    return;
  }

  const deleteFiles = url.searchParams.get("deleteFiles") === "true";
  try {
    const result = await withWorkspaceRevision(
      workspace.rootPath,
      expectedRevision.data,
      async (current) => {
        // Linearize deletion before index/filesystem changes: no old request may
        // attach a Session or keep a WikiRuns SQLite owner after this point.
        const deletion = await beginWorkspaceDeletion(current.rootPath, current.id);
        let controlStoreLease:
          | Awaited<ReturnType<typeof acquireWikiRunsControlStoreLease>>
          | undefined;
        let deletionCommitted = false;
        let removalStarted = false;
        try {
          await retireOperatorSessionsForDeletedWorkspace(current.id);
          await closeWikiRunsForDeletedWorkspace(current);
          await assertNoWorkspaceActivityLeases(current.rootPath);
          controlStoreLease = await acquireWikiRunsControlStoreLease(current.rootPath, {
            allowWorkspaceDeletion: true,
          });
          await assertNoWorkspaceActivityLeases(current.rootPath);
          await removeWorkspaceFromAppIndex(current.rootPath);
          removalStarted = true;
          if (deleteFiles) await deleteWorkspaceMeta(current.rootPath);
          await deletion.complete();
          deletionCommitted = true;
          return { rootPath: current.rootPath, deletedMeta: deleteFiles };
        } catch (error) {
          if (!deletionCommitted && !removalStarted) {
            await deletion.abort();
            restoreOperatorSessionsAfterFailedWorkspaceDeletion(current.id);
            restoreWikiRunsAfterFailedWorkspaceDeletion(current);
          }
          throw error;
        } finally {
          if (controlStoreLease) await controlStoreLease.release();
        }
      },
    );

    getLogger().info(
      {
        event: "workspace.delete",
        workspaceId: id,
        rootPath: result.rootPath,
        deleteFiles,
        deletedMeta: result.deletedMeta,
      },
      "workspace removed from index",
    );
    sendJson(res, 200, {
      ok: true,
      id,
      removedFromIndex: true,
      deletedMeta: result.deletedMeta,
      rootPath: result.rootPath,
    });
  } catch (error) {
    if (sendWorkspaceRevisionConflict(res, error)) return;
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 500, error);
  }
}

export async function handleAddSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const raw = await readJsonBody(req);
  const parsed = SourceAddSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(res, 400, "invalid add source body", parsed.error.flatten());
    return;
  }

  const sourcePath = path.resolve(parsed.data.path);
  const desiredId = parsed.data.id?.trim() || slugFromPath(sourcePath);
  let sourceId = desiredId;
  let result: Awaited<ReturnType<typeof addSource>> | undefined;

  try {
    // Config editing: allow dirty trees; reject only non-git.
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      async (current) => {
        sourceId = uniqueSourceId(desiredId, current.sources);
        const added = await addSource(
          current,
          {
            id: sourceId,
            path: sourcePath,
            applyDefaultIgnores: parsed.data.applyDefaultIgnores,
            ignore: parsed.data.ignore,
          },
          { requireClean: false },
        );
        result = added;
        return added.config;
      },
    );
    if (!result) throw new Error("source add mutation did not produce a result");
    await invalidateOperatorSessions(next.id);
    getLogger().info(
      {
        event: "source.add",
        workspaceId: next.id,
        sourceId: result.source.id,
      },
      "source added",
    );
    sendJson(res, 201, {
      workspace: next,
      source: result.source,
      probe: result.probe,
    });
  } catch (error) {
    getLogger().warn(
      {
        event: "source.add",
        workspaceId: workspace.id,
        sourceId,
        err: redactErrorMessage(error),
      },
      "source add failed",
    );
    if (sendWorkspaceRevisionConflict(res, error)) return;
    // Attach probe for non-git so the client can show git status details.
    if (error instanceof WorkspaceIntakeError && error.code === "source_not_git") {
      const probe = await probeLocalGit(sourcePath);
      sendError(res, httpStatusForWorkspaceCode(error.code), error.message, { probe });
      return;
    }
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleDeleteSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sourceId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const parsed = WorkspaceRevisionRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid delete source body", parsed.error.flatten());
    return;
  }

  try {
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      (current) => removeSource(current, sourceId),
    );
    await invalidateOperatorSessions(next.id);
    getLogger().info(
      { event: "source.delete", workspaceId: workspace.id, sourceId },
      "source removed",
    );
    sendJson(res, 200, { workspace: next });
  } catch (error) {
    getLogger().warn(
      {
        event: "source.delete",
        workspaceId: workspace.id,
        sourceId,
        err: redactErrorMessage(error),
      },
      "source delete failed",
    );
    if (sendWorkspaceRevisionConflict(res, error)) return;
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleUpdateSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sourceId: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const parsed = SourceUpdateSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid update source body", parsed.error.flatten());
    return;
  }

  try {
    const { expectedRevision, ...sourcePatch } = parsed.data;
    const next = await mutateWorkspace(workspace.rootPath, expectedRevision, (current) =>
      updateSource(current, sourceId, sourcePatch),
    );
    await invalidateOperatorSessions(next.id);
    const source = next.sources.find((s) => s.id === sourceId);
    sendJson(res, 200, { workspace: next, source });
  } catch (error) {
    if (sendWorkspaceRevisionConflict(res, error)) return;
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleProbeSources(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const probes = await Promise.all(
    workspace.sources.map(async (source) => ({
      sourceId: source.id,
      probe: await probeLocalGit(source.path),
    })),
  );
  sendJson(res, 200, { workspaceId: workspace.id, probes });
}

export async function handleCloneSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;

  const parsed = SourceCloneSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid clone source body", parsed.error.flatten());
    return;
  }

  const remoteUrl = parsed.data.remoteUrl;
  const desiredId = parsed.data.id?.trim() || slugFromPath(remoteUrl.replace(/\.git$/i, ""));
  let sourceId = desiredId;
  const relativeDir = parsed.data.relativeDir;
  const ref = parsed.data.ref;

  getLogger().info(
    {
      event: "source.clone",
      workspaceId: workspace.id,
      sourceId,
      phase: "start",
      // remote host only — avoid logging credentials embedded in URLs
      remoteHost: safeRemoteHost(remoteUrl),
      ref: ref ?? null,
    },
    "source clone started",
  );
  try {
    let result: Awaited<ReturnType<typeof addSource>> | undefined;
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      async (current) => {
        sourceId = uniqueSourceId(desiredId, current.sources);
        const cloned = await cloneIntoWorkspace({
          workspaceRoot: current.rootPath,
          remoteUrl,
          sourceId,
          relativeDir,
          ref,
        });
        const added = await addSource(
          current,
          {
            id: sourceId,
            path: cloned.path,
            applyDefaultIgnores: parsed.data.applyDefaultIgnores,
            ignore: parsed.data.ignore,
            origin: {
              type: "clone",
              remoteUrl,
              ...(ref ? { ref } : {}),
              clonedAt: new Date().toISOString(),
            },
          },
          { requireClean: false },
        );
        result = added;
        return added.config;
      },
    );
    if (!result) throw new Error("source clone mutation did not produce a result");
    await invalidateOperatorSessions(next.id);
    getLogger().info(
      {
        event: "source.clone",
        workspaceId: next.id,
        sourceId: result.source.id,
        phase: "end",
      },
      "source clone completed",
    );
    sendJson(res, 201, {
      workspace: next,
      source: result.source,
      probe: result.probe,
    });
  } catch (error) {
    getLogger().error(
      {
        event: "source.clone",
        workspaceId: workspace.id,
        sourceId,
        phase: "end",
        err: redactErrorMessage(error),
      },
      "source clone failed",
    );
    if (sendWorkspaceRevisionConflict(res, error)) return;
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

/** Hostname (or truncated path) for logs — never the full URL with secrets. */
function safeRemoteHost(remoteUrl: string): string {
  try {
    if (remoteUrl.includes("://")) {
      return new URL(remoteUrl).host || "unknown";
    }
    // git@host:path form
    const m = /^[^@]+@([^:]+):/.exec(remoteUrl);
    if (m?.[1]) return m[1];
  } catch {
    // fall through
  }
  return "unknown";
}

export async function handleGetSkill(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const skill = await getSkillInfo(active);
    sendJson(res, 200, { skill });
  } catch (error) {
    sendCaughtError(res, 400, error);
  }
}

export async function handleCreateSkillFork(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const parsed = WorkspaceRevisionRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid create skill fork body", parsed.error.flatten());
    return;
  }
  try {
    // Fork from home/package default — not from an existing project skill.
    const fallback = await resolveSkillSource({});
    let forkPath: string | undefined;
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      async (current) => {
        const created = await createSkillFork({
          workspaceRoot: current.rootPath,
          sourceSkillPath: fallback.path,
        });
        forkPath = created;
        return { ...current, skillPath: created };
      },
    );
    if (!forkPath) throw new Error("skill fork mutation did not produce a path");
    await invalidateOperatorSessions(next.id);
    const skill = await getSkillInfo({ path: forkPath, kind: "fork" });
    sendJson(res, 201, { workspace: next, skill });
  } catch (error) {
    if (sendWorkspaceRevisionConflict(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleResetSkill(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const parsed = WorkspaceRevisionRequestSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid reset skill body", parsed.error.flatten());
    return;
  }
  try {
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      async (current) => {
        // Remove the project fork before committing the selector reset. If this
        // cannot complete, retain the prior selector instead of a half-reset.
        await rm(skillForkDir(current.rootPath), { recursive: true, force: true });
        const proposed = { ...current };
        delete proposed.skillPath;
        return proposed;
      },
    );
    await invalidateOperatorSessions(next.id);
    const active = await resolveSkillSource({
      workspaceRoot: next.rootPath,
    });
    const skill = await getSkillInfo(active);
    sendJson(res, 200, { workspace: next, skill });
  } catch (error) {
    if (sendWorkspaceRevisionConflict(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}

export async function handleListSkillFiles(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const dir = url.searchParams.get("path") ?? "";
  try {
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const entries = await listSkillDir(active.path, dir);
    sendJson(res, 200, {
      skillPath: active.path,
      path: dir,
      entries,
      writable: active.kind === "fork",
    });
  } catch (error) {
    sendCaughtError(res, 400, error);
  }
}

export async function handleReadSkillFile(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const filePath = url.searchParams.get("path") ?? "";
  if (!filePath.trim()) {
    sendError(res, 400, "path query is required");
    return;
  }
  try {
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const file = await readSkillFile(active.path, filePath);
    sendJson(res, 200, {
      file,
      writable: active.kind === "fork",
    });
  } catch (error) {
    sendCaughtError(res, 400, error);
  }
}

export async function handleWriteSkillFile(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  const parsed = WorkspaceSkillFileWriteSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid write skill file body", parsed.error.flatten());
    return;
  }
  try {
    let written: Awaited<ReturnType<typeof writeWorkspaceSkillFile>> | undefined;
    const next = await mutateWorkspace(
      workspace.rootPath,
      parsed.data.expectedRevision,
      async (current) => {
        const result = await writeWorkspaceSkillFile(
          current,
          parsed.data.path,
          parsed.data.content,
        );
        written = result;
        return current;
      },
    );
    if (!written) throw new Error("skill file mutation did not produce a file");
    await invalidateOperatorSessions(next.id);
    const skill = await getSkillInfo({ path: written.skillRoot, kind: "fork" });
    sendJson(res, 200, {
      workspace: next,
      file: written.file,
      skill,
      expectedFork: skillForkDir(next.rootPath),
    });
  } catch (error) {
    if (sendWorkspaceRevisionConflict(res, error)) return;
    if (trySendCoreDomainError(res, error)) return;
    sendCaughtError(res, 400, error);
  }
}
