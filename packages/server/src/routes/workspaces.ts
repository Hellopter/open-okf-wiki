import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  SourceAddSchema,
  SourceCloneSchema,
  type WorkspaceConfig,
  WorkspaceCreateSchema,
  WorkspacePatchSchema,
} from "@okf-wiki/contract";
import {
  addSource,
  cloneIntoWorkspace,
  createSkillFork,
  createWorkspace,
  deleteWorkspaceMeta,
  getSkillInfo,
  listSkillDir,
  listWorkspaceSummaries,
  probeLocalGit,
  readSkillFile,
  registerWorkspaceInAppIndex,
  removeSource,
  removeWorkspaceFromAppIndex,
  resolveSkillSource,
  saveWorkspace,
  skillForkDir,
  slugFromPath,
  uniqueSourceId,
  updateSource,
  WorkspaceIntakeError,
  writeSkillFile,
} from "@okf-wiki/core";
import { trySendCoreDomainError } from "../core-http-error.ts";
import { httpStatusForWorkspaceCode } from "../http-status.ts";
import { readJsonBody, sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import { resolveWorkspaceModelSelection } from "./provider.ts";

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
    });
    await saveWorkspace(workspace);
    await registerWorkspaceInAppIndex(workspace.rootPath);
    sendJson(res, 201, { workspace });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
  }
}

export async function handleGetWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  // Do not rewrite workspace.json for lastOpenedAt — only bump recents index.
  await registerWorkspaceInAppIndex(workspace.rootPath);
  sendJson(res, 200, { workspace });
}

export async function handlePatchWorkspace(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  // Contract boundary: strict schema — unknown keys are rejected, not ignored.
  const parsed = WorkspacePatchSchema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    sendError(res, 400, "invalid workspace patch body", parsed.error.flatten());
    return;
  }
  const body = parsed.data;
  const next: WorkspaceConfig = { ...workspace };

  if (body.name !== undefined) {
    next.name = body.name;
  }

  if (body.modelProfileId !== undefined || body.model !== undefined) {
    try {
      const profileId = body.modelProfileId ?? body.model?.profileId;
      if (!profileId) {
        sendError(res, 400, "modelProfileId is required (catalog profile selection)");
        return;
      }
      const model = await resolveWorkspaceModelSelection({ modelProfileId: profileId });
      next.model = {
        id: model.id,
        ...(model.profileId ? { profileId: model.profileId } : {}),
      };
    } catch (error) {
      if (trySendCoreDomainError(res, error)) return;
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 400, message);
      return;
    }
  }

  if (body.publicationPath !== undefined) {
    next.publicationPath = path.resolve(body.publicationPath);
  }

  if (body.limits !== undefined) {
    next.limits = body.limits;
  }

  if (body.skillPath !== undefined) {
    if (body.skillPath === null) {
      delete next.skillPath;
    } else {
      next.skillPath = path.resolve(body.skillPath);
    }
  }

  if (body.planConfirm !== undefined) {
    next.planConfirm = body.planConfirm;
  }

  if (body.wikiLanguage !== undefined) {
    next.wikiLanguage = body.wikiLanguage;
  }

  if (body.roleModels !== undefined) {
    next.roleModels = body.roleModels;
  }

  if (body.orchestration !== undefined) {
    next.orchestration = body.orchestration;
  }

  if (body.operatorTools !== undefined) {
    next.operatorTools = body.operatorTools;
  }

  // rootPath and id are immutable via PATCH
  await saveWorkspace(next);
  await registerWorkspaceInAppIndex(next.rootPath);
  sendJson(res, 200, { workspace: next });
}

export async function handleDeleteWorkspace(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  await removeWorkspaceFromAppIndex(workspace.rootPath);

  const deleteFiles = url.searchParams.get("deleteFiles") === "true";
  let deletedMeta = false;
  if (deleteFiles) {
    try {
      await deleteWorkspaceMeta(workspace.rootPath);
      deletedMeta = true;
    } catch (error) {
      sendError(
        res,
        500,
        "removed from index but failed to delete .okf-wiki",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
  }

  sendJson(res, 200, {
    ok: true,
    id,
    removedFromIndex: true,
    deletedMeta,
    rootPath: workspace.rootPath,
  });
}

export async function handleAddSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const raw = await readJsonBody(req);
  const parsed = SourceAddSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(res, 400, "invalid add source body", parsed.error.flatten());
    return;
  }

  const sourcePath = path.resolve(parsed.data.path);
  const desiredId = parsed.data.id?.trim() || slugFromPath(sourcePath);
  const sourceId = uniqueSourceId(desiredId, workspace.sources);

  try {
    // Config editing: allow dirty trees; reject only non-git.
    const result = await addSource(
      workspace,
      {
        id: sourceId,
        path: sourcePath,
        applyDefaultIgnores: parsed.data.applyDefaultIgnores,
        ignore: parsed.data.ignore,
      },
      { requireClean: false },
    );
    await saveWorkspace(result.config);
    sendJson(res, 201, {
      workspace: result.config,
      source: result.source,
      probe: result.probe,
    });
  } catch (error) {
    // Attach probe for non-git so the client can show git status details.
    if (error instanceof WorkspaceIntakeError && error.code === "source_not_git") {
      const probe = await probeLocalGit(sourcePath);
      sendError(res, httpStatusForWorkspaceCode(error.code), error.message, { probe });
      return;
    }
    if (trySendCoreDomainError(res, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
  }
}

export async function handleDeleteSource(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sourceId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  try {
    const next = removeSource(workspace, sourceId);
    await saveWorkspace(next);
    sendJson(res, 200, { workspace: next });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
  }
}

export async function handleUpdateSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  sourceId: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const body = (await readJsonBody(req)) as {
    applyDefaultIgnores?: unknown;
    ignore?: unknown;
  };

  const patch: { applyDefaultIgnores?: boolean; ignore?: string[] } = {};
  if (body.applyDefaultIgnores !== undefined) {
    if (typeof body.applyDefaultIgnores !== "boolean") {
      sendError(res, 400, "applyDefaultIgnores must be a boolean");
      return;
    }
    patch.applyDefaultIgnores = body.applyDefaultIgnores;
  }
  if (body.ignore !== undefined) {
    if (!Array.isArray(body.ignore) || !body.ignore.every((p) => typeof p === "string")) {
      sendError(res, 400, "ignore must be an array of strings");
      return;
    }
    patch.ignore = body.ignore as string[];
  }
  if (patch.applyDefaultIgnores === undefined && patch.ignore === undefined) {
    sendError(res, 400, "provide applyDefaultIgnores and/or ignore");
    return;
  }

  try {
    const next = updateSource(workspace, sourceId, patch);
    await saveWorkspace(next);
    const source = next.sources.find((s) => s.id === sourceId);
    sendJson(res, 200, { workspace: next, source });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
  }
}

export async function handleProbeSources(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const probes = await Promise.all(
    workspace.sources.map(async (source) => ({
      sourceId: source.id,
      probe: await probeLocalGit(source.path),
    })),
  );
  sendJson(res, 200, { workspaceId: workspace.id, probes });
}

/**
 * Persist a status change and emit matching SSE events.
 * When status is terminal, also emits a `done` event so streams close.
 * Does not overwrite an already-cancelled record (cancel wins races);
 * `updateRunRecord` enforces this under concurrent cancel/finalize.
 */

export async function handleCloneSource(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;

  const raw = (await readJsonBody(req)) as Record<string, unknown>;
  const parsed = SourceCloneSchema.safeParse(raw);
  if (!parsed.success) {
    sendError(res, 400, "invalid clone source body", parsed.error.flatten());
    return;
  }

  const remoteUrl = parsed.data.remoteUrl;
  const desiredId = parsed.data.id?.trim() || slugFromPath(remoteUrl.replace(/\.git$/i, ""));
  const sourceId = uniqueSourceId(desiredId, workspace.sources);
  // relativeDir is server-side layout, not part of SourceCloneSchema.
  const relativeDir =
    typeof raw.relativeDir === "string" && raw.relativeDir.trim()
      ? raw.relativeDir.trim()
      : undefined;
  const ref = parsed.data.ref;

  try {
    const cloned = await cloneIntoWorkspace({
      workspaceRoot: workspace.rootPath,
      remoteUrl,
      sourceId,
      relativeDir,
      ref,
    });
    const result = await addSource(
      workspace,
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
    await saveWorkspace(result.config);
    sendJson(res, 201, {
      workspace: result.config,
      source: result.source,
      probe: result.probe,
    });
  } catch (error) {
    if (trySendCoreDomainError(res, error)) return;
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message);
  }
}

export async function handleGetSkill(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  try {
    const active = await resolveSkillSource({
      skillPath: workspace.skillPath,
      workspaceRoot: workspace.rootPath,
    });
    const skill = await getSkillInfo(active);
    sendJson(res, 200, { skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleCreateSkillFork(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  try {
    // Fork from home/package default — not from an existing project skill.
    const fallback = await resolveSkillSource({});
    const forkPath = await createSkillFork({
      workspaceRoot: workspace.rootPath,
      sourceSkillPath: fallback.path,
    });
    const next = { ...workspace, skillPath: forkPath };
    await saveWorkspace(next);
    const skill = await getSkillInfo({ path: forkPath, kind: "fork" });
    sendJson(res, 201, { workspace: next, skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleResetSkill(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  const next = { ...workspace };
  delete next.skillPath;
  await saveWorkspace(next);
  // Remove project-level `.agents/skills/<producer>` so resolution falls back
  // to home/package (Grok-like: no project skill = not project-scoped).
  try {
    const projectSkill = skillForkDir(workspace.rootPath);
    await rm(projectSkill, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    const active = await resolveSkillSource({
      workspaceRoot: next.rootPath,
    });
    const skill = await getSkillInfo(active);
    sendJson(res, 200, { workspace: next, skill });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleListSkillFiles(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
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
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleReadSkillFile(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
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
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}

export async function handleWriteSkillFile(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id, url);
  if (!workspace) return;
  if (!workspace.skillPath) {
    sendError(res, 400, "create a skill fork before editing skill files");
    return;
  }
  const body = (await readJsonBody(req)) as { path?: unknown; content?: unknown };
  if (typeof body.path !== "string" || !body.path.trim()) {
    sendError(res, 400, "path is required");
    return;
  }
  if (typeof body.content !== "string") {
    sendError(res, 400, "content must be a string");
    return;
  }
  try {
    // Only write under the workspace `.agents/skills` producer path.
    const forkPath = path.resolve(workspace.skillPath);
    const expectedFork = skillForkDir(workspace.rootPath);
    if (path.resolve(forkPath) !== path.resolve(expectedFork)) {
      // Allow writing only into the canonical project skill directory.
      sendError(res, 400, `skill writes must target the project skill at ${expectedFork}`);
      return;
    }
    const file = await writeSkillFile(forkPath, body.path.trim(), body.content);
    const skill = await getSkillInfo({ path: forkPath, kind: "fork" });
    sendJson(res, 200, { file, skill, expectedFork });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : String(error));
  }
}
