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
import { request } from "./client";

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
  /** Supervisor tree budgets (partial; server fills schema defaults). */
  orchestration?: Partial<WorkspaceConfig["orchestration"]>;
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

export function getWorkspace(id: string): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>(`/api/workspaces/${encodeURIComponent(id)}`);
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
): Promise<{ workspace: WorkspaceConfig }> {
  return request<{ workspace: WorkspaceConfig }>(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/**
 * Remove workspace from the app index.
 * When deleteFiles is true, also removes `<root>/.okf-wiki` (not the whole project tree).
 */
export function deleteWorkspace(
  id: string,
  options?: { deleteFiles?: boolean },
): Promise<{
  ok: boolean;
  id: string;
  removedFromIndex: boolean;
  deletedMeta: boolean;
  rootPath: string;
}> {
  const base = `/api/workspaces/${encodeURIComponent(id)}`;
  const url = options?.deleteFiles ? `${base}?deleteFiles=true` : base;
  return request(url, { method: "DELETE" });
}

export function updateSource(
  workspaceId: string,
  sourceId: string,
  input: UpdateSourceInput,
): Promise<{ workspace: WorkspaceConfig; source: WorkspaceSource }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export function addSource(
  workspaceId: string,
  input: AddSourceInput,
): Promise<{
  workspace: WorkspaceConfig;
  source: WorkspaceSource;
  probe: GitProbe;
}> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Clone a remote git repo into the workspace and register it as a source. */
export function cloneSource(
  workspaceId: string,
  input: CloneSourceInput,
): Promise<{
  workspace: WorkspaceConfig;
  source: WorkspaceSource;
  probe: GitProbe;
}> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources/clone`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getWorkspaceSkill(workspaceId: string): Promise<{ skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill`);
}

export function createWorkspaceSkillFork(
  workspaceId: string,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/fork`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function resetWorkspaceSkill(
  workspaceId: string,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/reset`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listWorkspaceSkillFiles(
  workspaceId: string,
  dirPath?: string,
): Promise<{
  skillPath: string;
  path: string;
  entries: SkillFileEntry[];
  writable: boolean;
}> {
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`;
  const url =
    dirPath && dirPath.trim() ? `${base}?path=${encodeURIComponent(dirPath.trim())}` : base;
  return request(url);
}

export function readWorkspaceSkillFile(
  workspaceId: string,
  filePath: string,
): Promise<{ file: SkillFileContent; writable: boolean }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/file?path=${encodeURIComponent(filePath)}`,
  );
}

export function writeWorkspaceSkillFile(
  workspaceId: string,
  input: { path: string; content: string },
): Promise<{ file: SkillFileContent; skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function deleteSource(
  workspaceId: string,
  sourceId: string,
): Promise<{ workspace: WorkspaceConfig }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE" },
  );
}

export function probeSources(
  workspaceId: string,
): Promise<{ workspaceId: string; probes: SourceProbeResult[] }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources/probe`, {
    method: "POST",
  });
}
