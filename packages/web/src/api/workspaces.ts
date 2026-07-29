/**
 * Workspaces, sources, skill, and probe HTTP API.
 * Domain types come from `@okf-wiki/contract` — do not redeclare schemas here.
 */

import type {
  GitProbe,
  SkillFileContent,
  SkillFileEntry,
  SkillInfo,
  SourceOrigin,
  WikiLanguage,
  WorkspaceConfig,
  WorkspaceSource,
  WorkspaceSummary,
} from "@okf-wiki/contract";
import { request, withRootPathQuery } from "./client";

export type {
  GitProbe,
  SkillFileContent,
  SkillFileEntry,
  SkillInfo,
  SourceOrigin,
  WikiLanguage,
  WorkspaceConfig,
  WorkspaceSource,
  WorkspaceSummary,
};

export type SourceProbeResult = {
  sourceId: string;
  probe: GitProbe;
};

export type CreateWorkspaceInput = {
  name: string;
  rootPath: string;
  publicationPath?: string;
  /** Catalog model profile id (required when Settings has models). */
  modelProfileId?: string;
};

export type PatchWorkspaceInput = {
  name?: string;
  /** Catalog model profile id; denormalized model.id is resolved server-side. */
  modelProfileId?: string;
  publicationPath?: string;
  planConfirm?: boolean;
  wikiLanguage?: WikiLanguage;
  skillPath?: string | null;
  /** Full workspace limits document (server replaces the limits object). */
  limits?: WorkspaceConfig["limits"];
  /** Hybrid model economics: planner / worker / writer / reviewers. */
  roleModels?: WorkspaceConfig["roleModels"];
  /** Supervisor tree budgets. */
  orchestration?: WorkspaceConfig["orchestration"];
  /** Operator Session tool selection (read/grep/find/ls/bash subset). */
  operatorTools?: WorkspaceConfig["operatorTools"];
};

export type UpdateSourceInput = {
  applyDefaultIgnores?: boolean;
  ignore?: string[];
};

export type AddSourceInput = {
  path: string;
  id?: string;
};

export type CloneSourceInput = {
  remoteUrl: string;
  id?: string;
  relativeDir?: string;
  ref?: string;
};

export function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  return request<{ workspaces: WorkspaceSummary[] }>("/api/workspaces");
}

export function getWorkspace(
  id: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(id)}`, rootPath),
  );
}

export function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function patchWorkspace(
  id: string,
  input: PatchWorkspaceInput,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(id)}`, rootPath),
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

/**
 * Remove workspace from the app index.
 * When deleteFiles is true, also removes `<root>/.okf-wiki` (not the whole project tree).
 */
export function deleteWorkspace(
  id: string,
  options?: { rootPath?: string; deleteFiles?: boolean },
): Promise<{
  ok: boolean;
  id: string;
  removedFromIndex: boolean;
  deletedMeta: boolean;
  rootPath: string;
}> {
  const base = withRootPathQuery(`/api/workspaces/${encodeURIComponent(id)}`, options?.rootPath);
  const sep = base.includes("?") ? "&" : "?";
  const url = options?.deleteFiles ? `${base}${sep}deleteFiles=true` : base;
  return request(url, { method: "DELETE" });
}

export function updateSource(
  workspaceId: string,
  sourceId: string,
  input: UpdateSourceInput,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig; source: WorkspaceSource }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
      rootPath,
    ),
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export function addSource(
  workspaceId: string,
  input: AddSourceInput,
  rootPath?: string,
): Promise<{
  workspace: WorkspaceConfig;
  source: WorkspaceSource;
  probe: GitProbe;
}> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources`, rootPath),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

/** Clone a remote git repo into the workspace and register it as a source. */
export function cloneSource(
  workspaceId: string,
  input: CloneSourceInput,
  rootPath?: string,
): Promise<{
  workspace: WorkspaceConfig;
  source: WorkspaceSource;
  probe: GitProbe;
}> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources/clone`, rootPath),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export function getWorkspaceSkill(
  workspaceId: string,
  rootPath?: string,
): Promise<{ skill: SkillInfo }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill`, rootPath),
  );
}

export function createWorkspaceSkillFork(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/fork`, rootPath),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function resetWorkspaceSkill(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/reset`, rootPath),
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function listWorkspaceSkillFiles(
  workspaceId: string,
  dirPath?: string,
  rootPath?: string,
): Promise<{
  skillPath: string;
  path: string;
  entries: SkillFileEntry[];
  writable: boolean;
}> {
  const base = withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`,
    rootPath,
  );
  const sep = base.includes("?") ? "&" : "?";
  const url =
    dirPath && dirPath.trim() ? `${base}${sep}path=${encodeURIComponent(dirPath.trim())}` : base;
  return request(url);
}

export function readWorkspaceSkillFile(
  workspaceId: string,
  filePath: string,
  rootPath?: string,
): Promise<{ file: SkillFileContent; writable: boolean }> {
  const base = withRootPathQuery(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/file`,
    rootPath,
  );
  const sep = base.includes("?") ? "&" : "?";
  return request(`${base}${sep}path=${encodeURIComponent(filePath)}`);
}

export function writeWorkspaceSkillFile(
  workspaceId: string,
  input: { path: string; content: string },
  rootPath?: string,
): Promise<{ file: SkillFileContent; skill: SkillInfo }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`, rootPath),
    {
      method: "PUT",
      body: JSON.stringify(input),
    },
  );
}

export function deleteSource(
  workspaceId: string,
  sourceId: string,
  rootPath?: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request(
    withRootPathQuery(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
      rootPath,
    ),
    { method: "DELETE" },
  );
}

export function probeSources(
  workspaceId: string,
  rootPath?: string,
): Promise<{ workspaceId: string; probes: SourceProbeResult[] }> {
  return request(
    withRootPathQuery(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources/probe`, rootPath),
    { method: "POST" },
  );
}
