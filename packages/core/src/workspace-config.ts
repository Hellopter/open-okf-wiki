import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_OPERATOR_TOOLS,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  WorkspaceLimitsSchema,
  WorkspaceOrchestrationSchema,
  WorkspaceRoleModelsSchema,
} from "@okf-wiki/contract";
import { assertAbsolutePath, isPathInside, resolveExistingDir } from "./paths.js";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";
import { WorkspaceIntakeError } from "./workspace-errors.js";

export const WORKSPACE_FILE_NAME = "workspace.json";
export const DEFAULT_MODEL_ID = "openai/default";

/** Absolute path to `{root}/.okf-wiki/workspace.json`. */
export function workspaceConfigPath(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, WORKSPACE_FILE_NAME);
}

/** Absolute path to `{root}/.okf-wiki`. */
export function workspaceMetaDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME);
}

export type CreateWorkspaceOptions = {
  name: string;
  rootPath: string;
  publicationPath?: string;
  /** Settings model profile id; workspace model must come from the catalog. */
  modelProfileId?: string;
  /**
   * Denormalized served model id from the selected profile (display/runtime).
   * Must be resolved from catalog profile — not free-text API input.
   */
  resolvedModelId?: string;
};

/**
 * Create workspace directories and an in-memory config skeleton.
 * Call {@link saveWorkspace} to persist (empty sources allowed as a draft).
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceConfig> {
  if (typeof options.name !== "string" || options.name.trim() === "") {
    throw new WorkspaceIntakeError("invalid_name", "name must be a non-empty string");
  }

  const rootPath = path.resolve(assertAbsolutePath(options.rootPath, "rootPath"));
  await mkdir(rootPath, { recursive: true });

  const okfDir = path.join(rootPath, WORKSPACE_DIR_NAME);
  await mkdir(okfDir, { recursive: true });

  // Reject if a workspace.json already exists at this root.
  try {
    await access(workspaceConfigPath(rootPath));
    throw new WorkspaceIntakeError("workspace_exists", `workspace already exists at ${rootPath}`);
  } catch (error) {
    if (error instanceof WorkspaceIntakeError) {
      throw error;
    }
    // Only missing config is OK; re-throw EACCES/EPERM/etc.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const publicationPath =
    options.publicationPath !== undefined && options.publicationPath.trim() !== ""
      ? path.resolve(assertAbsolutePath(options.publicationPath, "publicationPath"))
      : path.join(rootPath, "wiki");
  await mkdir(publicationPath, { recursive: true });

  const modelId = options.resolvedModelId?.trim() || DEFAULT_MODEL_ID;
  const modelProfileId = options.modelProfileId?.trim() || undefined;

  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    name: options.name.trim(),
    rootPath,
    sources: [],
    model: {
      id: modelId,
      ...(modelProfileId ? { profileId: modelProfileId } : {}),
    },
    publicationPath,
    limits: WorkspaceLimitsSchema.parse({}),
    roleModels: WorkspaceRoleModelsSchema.parse({}),
    orchestration: WorkspaceOrchestrationSchema.parse({}),
    // Match WorkspaceConfigSchema default — HITL plan gate on unless operator opts out.
    planConfirm: true,
    operatorTools: [...DEFAULT_OPERATOR_TOOLS],
    wikiLanguage: "en",
    createdAt: now,
    lastOpenedAt: now,
  };
}

/** Load and validate `{rootPath}/.okf-wiki/workspace.json`. */
export async function loadWorkspace(rootPath: string): Promise<WorkspaceConfig> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  const filePath = workspaceConfigPath(resolvedRoot);

  // Path containment: only ever read workspace.json under <root>/.okf-wiki/
  if (!isPathInside(resolvedRoot, filePath)) {
    throw new WorkspaceIntakeError("path_escape", "workspace config path escapes root");
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new WorkspaceIntakeError(
      "workspace_not_found",
      `workspace config not found: ${filePath}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkspaceIntakeError("io", `invalid workspace JSON at ${filePath}: ${message}`, {
      cause: error,
    });
  }

  const parsed = WorkspaceConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new WorkspaceIntakeError(
      "io",
      `invalid workspace config at ${filePath}: ${parsed.error.message}`,
    );
  }

  // Prefer the requested rootPath (resolved) over a stale on-disk value.
  return { ...parsed.data, rootPath: resolvedRoot };
}

/** Validate and write `{config.rootPath}/.okf-wiki/workspace.json`. */
export async function saveWorkspace(config: WorkspaceConfig): Promise<void> {
  const parsed = WorkspaceConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`invalid workspace config: ${parsed.error.message}`);
  }

  const valid = parsed.data;
  const rootPath = path.resolve(valid.rootPath);
  const okfDir = path.join(rootPath, WORKSPACE_DIR_NAME);
  if (!isPathInside(rootPath, okfDir) || path.basename(okfDir) !== WORKSPACE_DIR_NAME) {
    throw new Error("refusing to write outside workspace meta directory");
  }
  await mkdir(okfDir, { recursive: true });

  const filePath = path.join(okfDir, WORKSPACE_FILE_NAME);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({ ...valid, rootPath }, null, 2)}\n`;

  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
}

/**
 * Carefully remove only `<root>/.okf-wiki` — never the whole workspace root.
 */
export async function deleteWorkspaceMeta(rootPath: string): Promise<void> {
  const resolved = path.resolve(rootPath);
  const meta = workspaceMetaDir(resolved);
  if (!isPathInside(resolved, meta) || path.resolve(meta) === resolved) {
    throw new Error("refusing to delete outside workspace meta directory");
  }
  if (path.basename(meta) !== WORKSPACE_DIR_NAME) {
    throw new Error("refusing to delete unexpected meta path");
  }
  await rm(meta, { recursive: true, force: true });
}
