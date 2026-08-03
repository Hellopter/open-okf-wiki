import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_OPERATOR_TOOLS, type WorkspaceConfig, WorkspaceConfigSchema, WorkspaceLimitsSchema, type WorkspaceOrchestration, WorkspaceOrchestrationSchema, WorkspaceRevisionSchema, WorkspaceRoleModelsSchema } from "@okf-wiki/contract/workspace";
import { atomicCreateJson, atomicWriteJson } from "./atomic-write.js";
import { withPerKeyMutex } from "./atomicity.js";
import { assertAbsolutePath, isPathInside, resolveExistingDir } from "./paths.js";
import { WORKSPACE_DIR_NAME } from "./run-layout.js";
import { registerWorkspaceInAppIndex } from "./workspace-app-state.js";
import { WorkspaceIntakeError } from "./workspace-errors.js";

export const WORKSPACE_FILE_NAME = "workspace.json";
export const DEFAULT_MODEL_ID = "openai/default";
export const WIKI_RUNS_CONTROL_STORE_FILE_NAME = "workflow.sqlite";
const WIKI_RUNS_CONTROL_STORE_LOCK_FILE_NAME = `${WIKI_RUNS_CONTROL_STORE_FILE_NAME}.lock`;
const WORKSPACE_CONFIG_LOCK_FILE_NAME = `${WORKSPACE_FILE_NAME}.lock`;
const WORKSPACE_CONFIG_LOCK_RETRY_MS = 10;
const WORKSPACE_CONFIG_LOCK_WAIT_MS = 30_000;
export const WORKSPACE_LIFECYCLE_DIR_NAME = ".okf-wiki.lifecycle";
const WORKSPACE_DELETION_FILE_NAME = "deletion.json";
const WORKSPACE_ACTIVITY_DIR_NAME = "activities";

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

/** Raised when another live Server instance holds a workspace config mutation lease. */
export class WorkspaceConfigLockedError extends Error {
  readonly code = "workspace_locked";

  constructor(
    readonly rootPath: string,
    readonly pid?: number,
  ) {
    super(
      pid === undefined
        ? `workspace configuration is busy for ${rootPath}`
        : `workspace configuration is busy for ${rootPath} by process ${pid}`,
    );
    this.name = "WorkspaceConfigLockedError";
  }
}

/** Raised when an operation targets a workspace that was deleted locally. */
export class WorkspaceDeletedError extends Error {
  readonly code = "workspace_deleted";

  constructor(
    readonly rootPath: string,
    readonly workspaceId?: string,
  ) {
    super(workspaceId ? `workspace deleted: ${workspaceId}` : `workspace deleted at ${rootPath}`);
    this.name = "WorkspaceDeletedError";
  }
}

/** Raised when another process is deleting or actively using a workspace. */
export class WorkspaceLifecycleInUseError extends Error {
  readonly code = "workspace_lifecycle_in_use";

  constructor(
    readonly rootPath: string,
    readonly pid?: number,
  ) {
    super(
      pid === undefined
        ? `workspace lifecycle is busy for ${rootPath}`
        : `workspace lifecycle is busy for ${rootPath} by process ${pid}`,
    );
    this.name = "WorkspaceLifecycleInUseError";
  }
}

export type WorkspaceMutation = (
  workspace: WorkspaceConfig,
) => WorkspaceConfig | Promise<WorkspaceConfig>;

export type ResetWikiRunsControlStoreResult = {
  rootPath: string;
  removed: string[];
};

export type WorkspaceActivityLease = {
  release(): Promise<void>;
};

export type WorkspaceDeletionLease = {
  complete(): Promise<void>;
  abort(): Promise<void>;
};

type WorkspaceCreationLease = {
  abort(): Promise<void>;
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

/** A persistent coordination directory intentionally outside `.okf-wiki`. */
export function workspaceLifecycleDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_LIFECYCLE_DIR_NAME);
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
 * A persistent creation marker keeps stale writers from reviving a workspace
 * that was deleted and then recreated at the same root.
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceConfig> {
  if (typeof options.name !== "string" || options.name.trim() === "") {
    throw new WorkspaceIntakeError("invalid_name", "name must be a non-empty string");
  }

  const rootPath = path.resolve(assertAbsolutePath(options.rootPath, "rootPath"));
  await mkdir(rootPath, { recursive: true });

  const publicationPath =
    options.publicationPath !== undefined && options.publicationPath.trim() !== ""
      ? path.resolve(assertAbsolutePath(options.publicationPath, "publicationPath"))
      : path.join(rootPath, "wiki");

  const modelId = options.resolvedModelId?.trim() || DEFAULT_MODEL_ID;
  const modelProfileId = options.modelProfileId?.trim() || undefined;

  const now = new Date().toISOString();
  const config: WorkspaceConfig = {
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

  const creation = await beginWorkspaceCreation(rootPath, config.id);
  try {
    await mkdir(path.join(rootPath, WORKSPACE_DIR_NAME), { recursive: true });
    await mkdir(publicationPath, { recursive: true });
    return config;
  } catch (error) {
    await creation.abort();
    throw error;
  }
}

/** Load and validate `{rootPath}/.okf-wiki/workspace.json`. */
export async function loadWorkspace(rootPath: string): Promise<WorkspaceConfig> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  const recovered = await recoverInterruptedWorkspaceDeletion(resolvedRoot);
  await assertWorkspaceActive(resolvedRoot);
  const workspace = await loadWorkspaceAtRoot(resolvedRoot);
  if (recovered) await registerActiveWorkspaceInAppIndex(resolvedRoot);
  return workspace;
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

async function tryLoadWorkspaceAtRoot(rootPath: string): Promise<WorkspaceConfig | undefined> {
  try {
    return await loadWorkspaceAtRoot(rootPath);
  } catch (error) {
    if (error instanceof WorkspaceIntakeError && error.code === "workspace_not_found") {
      return undefined;
    }
    throw error;
  }
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

  await withWorkspaceConfigLock(
    valid.rootPath,
    filePath,
    async () => {
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
        await completeWorkspaceCreation(valid.rootPath, valid.id);
        return;
      }

      assertSameWorkspace(current, valid);
      if (valid.revision !== current.revision) {
        throw new WorkspaceRevisionConflictError(valid.revision, current);
      }
      await writeWorkspaceAtRoot({ ...valid, revision: current.revision + 1 });
    },
    valid.id,
  );
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
  return withWorkspaceConfigLock(resolvedRoot, filePath, async () => {
    const current = await loadWorkspaceAtRoot(resolvedRoot);
    if (current.revision !== revision.data) {
      throw new WorkspaceRevisionConflictError(revision.data, current);
    }
    return operation(current);
  });
}

/**
 * Combine the local queue with an on-disk lease so revision checks remain a
 * compare-and-swap across multiple Server processes sharing one workspace.
 */
async function withWorkspaceConfigLock<T>(
  rootPath: string,
  filePath: string,
  operation: () => Promise<T>,
  creatingWorkspaceId?: string,
): Promise<T> {
  return withPerKeyMutex(workspaceConfigQueues, filePath, async () => {
    const lease = await acquireWorkspaceConfigLease(rootPath);
    try {
      await assertWorkspaceWritable(rootPath, creatingWorkspaceId);
      return await operation();
    } finally {
      await lease.release();
    }
  });
}

async function acquireWorkspaceConfigLease(rootPath: string): Promise<WikiRunsControlStoreLease> {
  const lockPath = path.join(workspaceLifecycleDir(rootPath), WORKSPACE_CONFIG_LOCK_FILE_NAME);
  const deadline = Date.now() + WORKSPACE_CONFIG_LOCK_WAIT_MS;
  const token = randomUUID();
  return acquireAtomicFileLease(lockPath, token, async (holder) => {
    if (Date.now() >= deadline) {
      throw new WorkspaceConfigLockedError(rootPath, holder.pid);
    }
    await sleep(WORKSPACE_CONFIG_LOCK_RETRY_MS);
  });
}

/** Reserve an empty root for one config until its first successful save. */
async function beginWorkspaceCreation(
  rootPath: string,
  workspaceId: string,
): Promise<WorkspaceCreationLease> {
  const configLease = await acquireWorkspaceConfigLease(rootPath);
  const markerPath = workspaceDeletionPath(rootPath);
  const token = randomUUID();

  try {
    const marker = await readWorkspaceLifecycleMarker(rootPath);
    const existing = await tryLoadWorkspaceAtRoot(rootPath);
    if (existing) {
      if (marker?.state === "deleting") {
        if (marker.pid !== undefined && isProcessAlive(marker.pid)) {
          throw new WorkspaceLifecycleInUseError(rootPath, marker.pid);
        }
        if (marker.workspaceId !== undefined && marker.workspaceId !== existing.id) {
          throw new WorkspaceLifecycleInUseError(rootPath, marker.pid);
        }
        await rm(markerPath, { force: true });
        await registerWorkspaceInAppIndex(rootPath);
      }
      if (marker?.state === "creating" && marker.workspaceId === existing.id) {
        await rm(markerPath, { force: true });
      }
      throw new WorkspaceIntakeError("workspace_exists", `workspace already exists at ${rootPath}`);
    }

    if (
      marker &&
      marker.state !== "deleted" &&
      marker.pid !== undefined &&
      isProcessAlive(marker.pid)
    ) {
      throw new WorkspaceLifecycleInUseError(rootPath, marker.pid);
    }

    await atomicWriteJson(markerPath, {
      state: "creating",
      workspaceId,
      pid: process.pid,
      token,
    });
    return {
      abort: async () => {
        const current = await readWorkspaceLifecycleMarker(rootPath);
        if (current?.state === "creating" && current.token === token) {
          await rm(markerPath, { force: true });
        }
      },
    };
  } finally {
    await configLease.release();
  }
}

async function completeWorkspaceCreation(rootPath: string, workspaceId: string): Promise<void> {
  const markerPath = workspaceDeletionPath(rootPath);
  const marker = await readWorkspaceLifecycleMarker(rootPath);
  if (!marker) return;
  if (marker.state !== "creating" || marker.workspaceId !== workspaceId) {
    throw new WorkspaceLifecycleInUseError(rootPath, marker.pid);
  }
  await rm(markerPath, { force: true });
}

type WorkspaceLifecycleRecord = {
  state: "creating" | "deleting" | "deleted";
  workspaceId?: string;
  pid?: number;
  token?: string;
};

type WorkspaceActivityRecord = {
  pid?: number;
  token?: string;
  workspaceId?: string;
};

function workspaceDeletionPath(rootPath: string): string {
  return path.join(workspaceLifecycleDir(rootPath), WORKSPACE_DELETION_FILE_NAME);
}

function workspaceActivityDir(rootPath: string): string {
  return path.join(workspaceLifecycleDir(rootPath), WORKSPACE_ACTIVITY_DIR_NAME);
}

/** Reject new work while an in-progress or completed deletion marker exists. */
export async function assertWorkspaceActive(rootPath: string): Promise<void> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  await recoverInterruptedWorkspaceDeletion(resolvedRoot);
  const marker = await readWorkspaceLifecycleMarker(resolvedRoot);
  if (!marker) return;
  if (marker.state === "creating") {
    const current = await tryLoadWorkspaceAtRoot(resolvedRoot);
    if (current?.id === marker.workspaceId) {
      await rm(workspaceDeletionPath(resolvedRoot), { force: true });
      return;
    }
    throw new WorkspaceLifecycleInUseError(resolvedRoot, marker.pid);
  }
  if (marker.state === "deleted") {
    throw new WorkspaceDeletedError(resolvedRoot, marker.workspaceId);
  }
  throw new WorkspaceLifecycleInUseError(resolvedRoot, marker.pid);
}

/**
 * A process can die after beginning deletion. If metadata still exists, the
 * only non-destructive recovery is to restore that Workspace to active state;
 * if metadata is already gone, preserve the completed deletion tombstone.
 */
async function recoverInterruptedWorkspaceDeletion(rootPath: string): Promise<boolean> {
  const initial = await readWorkspaceLifecycleMarker(rootPath);
  if (initial?.state !== "deleting" || (initial.pid !== undefined && isProcessAlive(initial.pid))) {
    return false;
  }

  const configLease = await acquireWorkspaceConfigLease(rootPath);
  try {
    const marker = await readWorkspaceLifecycleMarker(rootPath);
    if (marker?.state !== "deleting" || (marker.pid !== undefined && isProcessAlive(marker.pid))) {
      return false;
    }
    const current = await tryLoadWorkspaceAtRoot(rootPath);
    if (!current) {
      await atomicWriteJson(workspaceDeletionPath(rootPath), {
        state: "deleted",
        ...(marker.workspaceId ? { workspaceId: marker.workspaceId } : {}),
      });
      return false;
    }
    if (marker.workspaceId !== undefined && marker.workspaceId !== current.id) {
      throw new WorkspaceLifecycleInUseError(rootPath, marker.pid);
    }
    await rm(workspaceDeletionPath(rootPath), { force: true });
    return true;
  } finally {
    await configLease.release();
  }
}

/** Register a workspace only while it remains active under its config lock. */
export async function registerActiveWorkspaceInAppIndex(rootPath: string): Promise<void> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  const filePath = workspaceConfigPath(resolvedRoot);
  await withWorkspaceConfigLock(resolvedRoot, filePath, async () => {
    await loadWorkspaceAtRoot(resolvedRoot);
    await registerWorkspaceInAppIndex(resolvedRoot);
  });
}

/** Permit only the config that owns a creation marker to perform its first write. */
async function assertWorkspaceWritable(
  rootPath: string,
  creatingWorkspaceId?: string,
): Promise<void> {
  const marker = await readWorkspaceLifecycleMarker(rootPath);
  if (!marker) return;
  if (marker.state === "creating" && marker.workspaceId === creatingWorkspaceId) return;
  if (marker.state === "deleted") {
    throw new WorkspaceDeletedError(rootPath, marker.workspaceId);
  }
  throw new WorkspaceLifecycleInUseError(rootPath, marker.pid);
}

/**
 * Register a live Session or WikiRuns owner outside `.okf-wiki`. The deletion
 * marker is checked both before and after publishing the activity record.
 */
export async function acquireWorkspaceActivityLease(
  rootPath: string,
  workspaceId: string,
): Promise<WorkspaceActivityLease> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  await assertWorkspaceActive(resolvedRoot);
  const token = randomUUID();
  const leasePath = path.join(workspaceActivityDir(resolvedRoot), `${token}.json`);
  await atomicCreateJson(leasePath, { pid: process.pid, token, workspaceId });
  try {
    await assertWorkspaceActive(resolvedRoot);
  } catch (error) {
    await rm(leasePath, { force: true });
    throw error;
  }
  return {
    release: () => rm(leasePath, { force: true }),
  };
}

/** Refuse metadata deletion while another live process has a Session or owner. */
export async function assertNoWorkspaceActivityLeases(rootPath: string): Promise<void> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  const dir = workspaceActivityDir(resolvedRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const leasePath = path.join(dir, entry);
    const holder = await readWorkspaceActivityRecord(leasePath);
    if (holder.pid !== undefined && isProcessAlive(holder.pid)) {
      throw new WorkspaceLifecycleInUseError(resolvedRoot, holder.pid);
    }
    await rm(leasePath, { force: true });
  }
}

/** Start a persistent deletion boundary while the caller holds the config CAS lock. */
export async function beginWorkspaceDeletion(
  rootPath: string,
  workspaceId: string,
): Promise<WorkspaceDeletionLease> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  const markerPath = workspaceDeletionPath(resolvedRoot);
  const token = randomUUID();

  for (;;) {
    try {
      await atomicCreateJson(markerPath, {
        state: "deleting",
        workspaceId,
        pid: process.pid,
        token,
      });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const current = await readWorkspaceLifecycleMarker(resolvedRoot);
    if (current?.state === "deleted") {
      throw new WorkspaceDeletedError(resolvedRoot, current.workspaceId);
    }
    if (current?.pid !== undefined && isProcessAlive(current.pid)) {
      throw new WorkspaceLifecycleInUseError(resolvedRoot, current.pid);
    }

    const stalePath = `${markerPath}.stale-${randomUUID()}`;
    try {
      await rename(markerPath, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  return {
    complete: async () => {
      const current = await readWorkspaceLifecycleMarker(resolvedRoot);
      if (current?.state !== "deleting" || current.token !== token) {
        throw new WorkspaceLifecycleInUseError(resolvedRoot, current?.pid);
      }
      await atomicWriteJson(markerPath, { state: "deleted", workspaceId });
    },
    abort: async () => {
      const current = await readWorkspaceLifecycleMarker(resolvedRoot);
      if (current?.state === "deleting" && current.token === token) {
        await rm(markerPath, { force: true });
      }
    },
  };
}

/**
 * Acquire the cross-process lease for a live WikiRuns owner. Reset holds the
 * same lease, so it cannot unlink a control store beneath an active SQLite
 * connection. A dead process leaves a reclaimable marker.
 */
export async function acquireWikiRunsControlStoreLease(
  rootPath: string,
  options: { allowWorkspaceDeletion?: boolean } = {},
): Promise<WikiRunsControlStoreLease> {
  const absoluteRoot = assertAbsolutePath(rootPath, "workspace root");
  const resolvedRoot = await resolveExistingDir(absoluteRoot);
  if (!options.allowWorkspaceDeletion) await assertWorkspaceActive(resolvedRoot);
  await loadWorkspaceAtRoot(resolvedRoot);
  const lockPath = path.join(
    workspaceMetaDir(resolvedRoot),
    WIKI_RUNS_CONTROL_STORE_LOCK_FILE_NAME,
  );
  const token = randomUUID();
  return acquireAtomicFileLease(lockPath, token, async (holder) => {
    throw new WikiRunsControlStoreInUseError(resolvedRoot, holder.pid);
  });
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

type AtomicFileLeaseHolder = { pid?: number; token?: string };

/**
 * Atomically publish a complete lock record before another process can see it.
 * Stale lock recovery is only attempted after a holder is absent or dead.
 */
async function acquireAtomicFileLease(
  lockPath: string,
  token: string,
  onLiveHolder: (holder: AtomicFileLeaseHolder) => Promise<void>,
): Promise<WikiRunsControlStoreLease> {
  for (;;) {
    try {
      await atomicCreateJson(lockPath, { pid: process.pid, token });
      return {
        release: () => releaseAtomicFileLease(lockPath, token),
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }

    const holder = await readAtomicFileLease(lockPath);
    if (holder.pid !== undefined && isProcessAlive(holder.pid)) {
      await onLiveHolder(holder);
      continue;
    }

    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      await rename(lockPath, stalePath);
      await rm(stalePath, { force: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function releaseAtomicFileLease(lockPath: string, token: string): Promise<void> {
  try {
    const current = await readAtomicFileLease(lockPath);
    if (current.token === token) await rm(lockPath, { force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function readAtomicFileLease(lockPath: string): Promise<AtomicFileLeaseHolder> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    return {
      ...(Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
        ? { pid: parsed.pid as number }
        : {}),
      ...(typeof parsed.token === "string" && parsed.token.length > 0
        ? { token: parsed.token }
        : {}),
    };
  } catch {
    return {};
  }
}

async function readWorkspaceLifecycleMarker(
  rootPath: string,
): Promise<WorkspaceLifecycleRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(workspaceDeletionPath(rootPath), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as {
      state?: unknown;
      workspaceId?: unknown;
      pid?: unknown;
      token?: unknown;
    };
    if (parsed.state !== "creating" && parsed.state !== "deleting" && parsed.state !== "deleted") {
      throw new WorkspaceLifecycleInUseError(rootPath);
    }
    return {
      state: parsed.state,
      ...(typeof parsed.workspaceId === "string" ? { workspaceId: parsed.workspaceId } : {}),
      ...(Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
        ? { pid: parsed.pid as number }
        : {}),
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
    };
  } catch (error) {
    if (error instanceof WorkspaceLifecycleInUseError) throw error;
    throw new WorkspaceLifecycleInUseError(rootPath);
  }
}

async function readWorkspaceActivityRecord(leasePath: string): Promise<WorkspaceActivityRecord> {
  let raw: string;
  try {
    raw = await readFile(leasePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown; workspaceId?: unknown };
    return {
      ...(Number.isInteger(parsed.pid) && (parsed.pid as number) > 0
        ? { pid: parsed.pid as number }
        : {}),
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      ...(typeof parsed.workspaceId === "string" ? { workspaceId: parsed.workspaceId } : {}),
    };
  } catch {
    return {};
  }
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
