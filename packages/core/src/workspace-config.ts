import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_OPERATOR_TOOLS,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  WorkspaceLimitsSchema,
  type WorkspaceOrchestration,
  WorkspaceOrchestrationSchema,
  WorkspaceRevisionSchema,
  WorkspaceRoleModelsSchema,
} from "@okf-wiki/contract";
import { atomicWriteJson } from "./atomic-write.js";
import { withPerKeyMutex } from "./atomicity.js";
import { assertAbsolutePath, isPathInside, resolveExistingDir } from "./paths.js";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";
import { WorkspaceIntakeError } from "./workspace-errors.js";

export const WORKSPACE_FILE_NAME = "workspace.json";
export const DEFAULT_MODEL_ID = "openai/default";
export const WIKI_RUNS_CONTROL_STORE_FILE_NAME = "workflow.sqlite";
const WIKI_RUNS_CONTROL_STORE_LOCK_FILE_NAME = `${WIKI_RUNS_CONTROL_STORE_FILE_NAME}.lock`;

const workspaceConfigQueues = new Map<string, Promise<unknown>>();

/** Raised when a caller tries to write against an old Workspace revision. */
export class WorkspaceRevisionConflictError extends Error {
  readonly code = "stale_revision";

  constructor(
    readonly expectedRevision: number,
    readonly current: WorkspaceConfig,
  ) {
    super(`workspace revision conflict: expected ${expectedRevision}, current ${current.revision}`);
    this.name = "WorkspaceRevisionConflictError";
  }
}

export type WorkspaceMutation = (
  workspace: WorkspaceConfig,
) => WorkspaceConfig | Promise<WorkspaceConfig>;

export type ResetWikiRunsControlStoreResult = {
  rootPath: string;
  removed: string[];
};

/** Raised when a process already owns the durable WikiRuns store for a Workspace. */
export class WikiRunsControlStoreInUseError extends Error {
  readonly code = "control_store_in_use";

  constructor(
    readonly rootPath: string,
    readonly pid?: number,
  ) {
    super(
      pid === undefined
        ? `WikiRuns control store is in use for ${rootPath}`
        : `WikiRuns control store is in use for ${rootPath} by process ${pid}`,
    );
    this.name = "WikiRunsControlStoreInUseError";
  }
}

/** Lease held by a server-side WikiRuns owner while its SQLite connection is live. */
export type WikiRunsControlStoreLease = {
  release(): Promise<void>;
};

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
  /** Required v3 scheduler capacity selected by the operator. */
  orchestration: Pick<WorkspaceOrchestration, "maxActiveRuns" | "maxConcurrentAttempts"> &
    Partial<WorkspaceOrchestration>;
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
    version: 3,
    revision: 0,
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
    orchestration: WorkspaceOrchestrationSchema.parse(options.orchestration),
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
  return loadWorkspaceAtRoot(resolvedRoot);
}

async function loadWorkspaceAtRoot(resolvedRoot: string): Promise<WorkspaceConfig> {
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

/**
 * Persist a complete Workspace document with a compare-and-swap revision check.
 *
 * New Workspace documents retain revision zero. For existing documents the
 * supplied revision is the expected revision and a successful save advances it.
 * New production writes should prefer {@link mutateWorkspace}, which owns the
 * read-modify-write cycle in one serialized operation.
 */
export async function saveWorkspace(config: WorkspaceConfig): Promise<void> {
  const valid = normalizeWorkspaceForWrite(config);
  const filePath = workspaceConfigPath(valid.rootPath);

  await withPerKeyMutex(workspaceConfigQueues, filePath, async () => {
    let current: WorkspaceConfig | undefined;
    try {
      current = await loadWorkspaceAtRoot(valid.rootPath);
    } catch (error) {
      if (!(error instanceof WorkspaceIntakeError) || error.code !== "workspace_not_found") {
        throw error;
      }
    }

    if (!current) {
      await writeWorkspaceAtRoot(valid);
      return;
    }

    assertSameWorkspace(current, valid);
    if (valid.revision !== current.revision) {
      throw new WorkspaceRevisionConflictError(valid.revision, current);
    }
    await writeWorkspaceAtRoot({ ...valid, revision: current.revision + 1 });
  });
}

/**
 * Serialize a Workspace read-modify-write cycle for one canonical config path.
 * A stale expected revision is rejected before the mutation callback runs.
 */
export async function mutateWorkspace(
  rootPath: string,
  expectedRevision: number,
  mutate: WorkspaceMutation,
): Promise<WorkspaceConfig> {
  return withWorkspaceRevision(rootPath, expectedRevision, async (current) => {
    const proposed = normalizeWorkspaceForWrite(await mutate(current));
    assertSameWorkspace(current, proposed);
    const next = { ...proposed, revision: current.revision + 1 };
    await writeWorkspaceAtRoot(next);
    return next;
  });
}

/**
 * Serialize an operation that depends on the current Workspace revision without
 * requiring that operation to persist another Workspace document.
 */
export async function withWorkspaceRevision<T>(
  rootPath: string,
  expectedRevision: number,
  operation: (workspace: WorkspaceConfig) => T | Promise<T>,
): Promise<T> {
  const revision = WorkspaceRevisionSchema.safeParse(expectedRevision);
  if (!revision.success) {
    throw new Error("expectedRevision must be a non-negative integer");
  }

  const resolvedRoot = await resolveExistingDir(rootPath);
  const filePath = workspaceConfigPath(resolvedRoot);
  return withPerKeyMutex(workspaceConfigQueues, filePath, async () => {
    const current = await loadWorkspaceAtRoot(resolvedRoot);
    if (current.revision !== revision.data) {
      throw new WorkspaceRevisionConflictError(revision.data, current);
    }
    return operation(current);
  });
}

/**
 * Acquire the cross-process lease for a live WikiRuns owner. Reset holds the
 * same lease, so it cannot unlink a control store beneath an active SQLite
 * connection. A dead process leaves a reclaimable marker.
 */
export async function acquireWikiRunsControlStoreLease(
  rootPath: string,
): Promise<WikiRunsControlStoreLease> {
  const absoluteRoot = assertAbsolutePath(rootPath, "workspace root");
  const resolvedRoot = await resolveExistingDir(absoluteRoot);
  await loadWorkspaceAtRoot(resolvedRoot);
  const lockPath = path.join(
    workspaceMetaDir(resolvedRoot),
    WIKI_RUNS_CONTROL_STORE_LOCK_FILE_NAME,
  );
  const token = randomUUID();

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          try {
            const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
            if (current.token === token) await rm(lockPath, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw error;
    }

    const holder = await readControlStoreLock(lockPath);
    if (holder.pid !== undefined && isProcessAlive(holder.pid)) {
      throw new WikiRunsControlStoreInUseError(resolvedRoot, holder.pid);
    }

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
}

/**
 * Remove only the durable WikiRuns control state after an explicit operator
 * action. Workspace configuration and Pi Session JSONL stay intact.
 */
export async function resetWikiRunsControlStore(
  rootPath: string,
): Promise<ResetWikiRunsControlStoreResult> {
  const lease = await acquireWikiRunsControlStoreLease(rootPath);
  const absoluteRoot = assertAbsolutePath(rootPath, "workspace root");
  const resolvedRoot = await resolveExistingDir(absoluteRoot);

  try {
    const metaDir = workspaceMetaDir(resolvedRoot);
    const targets = [
      path.join(metaDir, WIKI_RUNS_CONTROL_STORE_FILE_NAME),
      path.join(metaDir, `${WIKI_RUNS_CONTROL_STORE_FILE_NAME}-wal`),
      path.join(metaDir, `${WIKI_RUNS_CONTROL_STORE_FILE_NAME}-shm`),
      path.join(metaDir, "runs"),
    ];

    for (const target of targets) {
      if (!isPathInside(resolvedRoot, target) || path.dirname(target) !== metaDir) {
        throw new Error("refusing to reset outside workspace control paths");
      }
    }

    const removed: string[] = [];
    for (const target of targets) {
      await rm(target, { recursive: true, force: true });
      removed.push(path.basename(target));
    }
    return { rootPath: resolvedRoot, removed };
  } finally {
    await lease.release();
  }
}

/** Parse the strict, confirmation-gated reset command arguments. */
export function parseResetWikiRunsControlStoreArgs(args: readonly string[]): { rootPath: string } {
  let rootPath: string | undefined;
  let confirmed = false;
  const commandArgs = args[0] === "--" ? args.slice(1) : args;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--yes") {
      if (confirmed) throw new Error("--yes may be provided only once");
      confirmed = true;
      continue;
    }
    if (arg === "--workspace") {
      if (rootPath !== undefined) throw new Error("--workspace may be provided only once");
      const value = commandArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--workspace requires an absolute path");
      }
      rootPath = assertAbsolutePath(value, "workspace root");
      index += 1;
      continue;
    }
    throw new Error(`unknown reset-control-store argument: ${arg}`);
  }

  if (!confirmed) throw new Error("reset-control-store requires --yes");
  if (!rootPath) throw new Error("reset-control-store requires --workspace <absolute-path>");
  return { rootPath };
}

function normalizeWorkspaceForWrite(config: WorkspaceConfig): WorkspaceConfig {
  const parsed = WorkspaceConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`invalid workspace config: ${parsed.error.message}`);
  }

  const rootPath = assertAbsolutePath(parsed.data.rootPath, "workspace root");
  const resolvedRoot = path.resolve(rootPath);
  const okfDir = path.join(resolvedRoot, WORKSPACE_DIR_NAME);
  if (!isPathInside(resolvedRoot, okfDir) || path.basename(okfDir) !== WORKSPACE_DIR_NAME) {
    throw new Error("refusing to write outside workspace meta directory");
  }
  return { ...parsed.data, rootPath: resolvedRoot };
}

function assertSameWorkspace(current: WorkspaceConfig, proposed: WorkspaceConfig): void {
  if (current.id !== proposed.id) {
    throw new Error("workspace id is immutable");
  }
  if (current.rootPath !== proposed.rootPath) {
    throw new Error("workspace rootPath is immutable");
  }
}

async function writeWorkspaceAtRoot(config: WorkspaceConfig): Promise<void> {
  const filePath = workspaceConfigPath(config.rootPath);
  await atomicWriteJson(filePath, config);
}

async function readControlStoreLock(lockPath: string): Promise<{ pid?: number }> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
      ? { pid: parsed.pid as number }
      : {};
  } catch {
    return {};
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
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
