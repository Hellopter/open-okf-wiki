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
import {
  GitProbeSchema,
  SkillFileContentSchema,
  SkillFileEntrySchema,
  SkillInfoSchema,
  WorkspaceConfigSchema,
  WorkspaceSourceSchema,
  WorkspaceSummarySchema,
} from "@okf-wiki/contract";
import { z } from "zod";
import { ApiError, request } from "./client";

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

/** Decode the authoritative Workspace returned with a stale write rejection. */
export function workspaceFromRevisionConflict(error: unknown): WorkspaceConfig | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (!error.body || typeof error.body !== "object") return null;
  const details = (error.body as Record<string, unknown>).details;
  if (!details || typeof details !== "object") return null;
  const parsed = WorkspaceConfigSchema.safeParse((details as Record<string, unknown>).workspace);
  return parsed.success ? parsed.data : null;
}

export type CreateWorkspaceInput = {
  name: string;
  rootPath: string;
  publicationPath?: string;
  /** Catalog model profile id (required when Settings has models). */
  modelProfileId?: string;
  orchestration: Pick<WorkspaceConfig["orchestration"], "maxActiveRuns" | "maxConcurrentAttempts">;
};

export type PatchWorkspaceInput = {
  expectedRevision: number;
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
};

export type UpdateSourceInput = {
  expectedRevision: number;
  applyDefaultIgnores?: boolean;
  ignore?: string[];
};

export type AddSourceInput = {
  expectedRevision: number;
  path: string;
  id?: string;
};

export type CloneSourceInput = {
  expectedRevision: number;
  remoteUrl: string;
  id?: string;
  relativeDir?: string;
  ref?: string;
};

const WorkspacesResponseSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema) });
const WorkspaceResponseSchema = z.object({ workspace: WorkspaceConfigSchema });
const DeleteWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  removedFromIndex: z.boolean(),
  deletedMeta: z.boolean(),
  rootPath: z.string(),
});
const SourceResponseSchema = WorkspaceResponseSchema.extend({ source: WorkspaceSourceSchema });
const SourceWithProbeResponseSchema = SourceResponseSchema.extend({ probe: GitProbeSchema });
const SkillResponseSchema = z.object({ skill: SkillInfoSchema });
const WorkspaceSkillResponseSchema = WorkspaceResponseSchema.extend({ skill: SkillInfoSchema });
const SkillFilesResponseSchema = z.object({
  skillPath: z.string(),
  path: z.string(),
  entries: z.array(SkillFileEntrySchema),
  writable: z.boolean(),
});
const SkillFileResponseSchema = z.object({ file: SkillFileContentSchema, writable: z.boolean() });
const WriteSkillFileResponseSchema = z.object({
  workspace: WorkspaceConfigSchema,
  file: SkillFileContentSchema,
  skill: SkillInfoSchema,
});
const SourceProbesResponseSchema = z.object({
  workspaceId: z.string(),
  probes: z.array(z.object({ sourceId: z.string(), probe: GitProbeSchema })),
});

export function listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
  return request("/api/workspaces").then(WorkspacesResponseSchema.parse);
}

export function getWorkspace(
  id: string,
  init?: Pick<RequestInit, "signal">,
): Promise<{ workspace: WorkspaceConfig }> {
  return request(`/api/workspaces/${encodeURIComponent(id)}`, init).then(
    WorkspaceResponseSchema.parse,
  );
}

export function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<{ workspace: WorkspaceConfig }> {
  return request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  }).then(WorkspaceResponseSchema.parse);
}

export function patchWorkspace(
  id: string,
  input: PatchWorkspaceInput,
): Promise<{ workspace: WorkspaceConfig }> {
  return request(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }).then(WorkspaceResponseSchema.parse);
}

/**
 * Remove workspace from the app index.
 * When deleteFiles is true, also removes `<root>/.okf-wiki` (not the whole project tree).
 */
export function deleteWorkspace(
  id: string,
  options: { deleteFiles?: boolean; expectedRevision: number },
): Promise<{
  ok: boolean;
  id: string;
  removedFromIndex: boolean;
  deletedMeta: boolean;
  rootPath: string;
}> {
  const base = `/api/workspaces/${encodeURIComponent(id)}`;
  const params = new URLSearchParams({ expectedRevision: String(options.expectedRevision) });
  if (options.deleteFiles) params.set("deleteFiles", "true");
  const url = `${base}?${params}`;
  return request(url, { method: "DELETE" }).then(DeleteWorkspaceResponseSchema.parse);
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
  ).then(SourceResponseSchema.parse);
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
  }).then(SourceWithProbeResponseSchema.parse);
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
  }).then(SourceWithProbeResponseSchema.parse);
}

export function getWorkspaceSkill(workspaceId: string): Promise<{ skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill`).then(
    SkillResponseSchema.parse,
  );
}

export function createWorkspaceSkillFork(
  workspaceId: string,
  expectedRevision: number,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/fork`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  }).then(WorkspaceSkillResponseSchema.parse);
}

export function resetWorkspaceSkill(
  workspaceId: string,
  expectedRevision: number,
): Promise<{ workspace: WorkspaceConfig; skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/reset`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  }).then(WorkspaceSkillResponseSchema.parse);
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
  return request(url).then(SkillFilesResponseSchema.parse);
}

export function readWorkspaceSkillFile(
  workspaceId: string,
  filePath: string,
): Promise<{ file: SkillFileContent; writable: boolean }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/skill/file?path=${encodeURIComponent(filePath)}`,
  ).then(SkillFileResponseSchema.parse);
}

export function writeWorkspaceSkillFile(
  workspaceId: string,
  input: { expectedRevision: number; path: string; content: string },
): Promise<{ workspace: WorkspaceConfig; file: SkillFileContent; skill: SkillInfo }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill/files`, {
    method: "PUT",
    body: JSON.stringify(input),
  }).then(WriteSkillFileResponseSchema.parse);
}

export function deleteSource(
  workspaceId: string,
  sourceId: string,
  expectedRevision: number,
): Promise<{ workspace: WorkspaceConfig }> {
  return request(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/sources/${encodeURIComponent(sourceId)}`,
    { method: "DELETE", body: JSON.stringify({ expectedRevision }) },
  ).then(WorkspaceResponseSchema.parse);
}

export function probeSources(
  workspaceId: string,
): Promise<{ workspaceId: string; probes: SourceProbeResult[] }> {
  return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/sources/probe`, {
    method: "POST",
  }).then(SourceProbesResponseSchema.parse);
}
