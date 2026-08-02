/** One long-lived WikiRuns owner per workspace root for this Server process. */
import { createPiAttemptExecutor, shouldUsePiFixtureMode } from "@okf-wiki/agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import {
  acquireWikiRunsControlStoreLease,
  acquireWorkspaceActivityLease,
  assertWorkspaceActive,
  type WikiRunsControlStoreLease,
  type WorkspaceActivityLease,
  WorkspaceDeletedError,
  WorkspaceLifecycleInUseError,
} from "@okf-wiki/core";
import { openWikiRuns, type WikiRuns } from "@okf-wiki/workflow";
import { getLogger } from "./logging/index.ts";

const owners = new Map<string, WikiRuns>();
const opening = new Map<string, Promise<WikiRuns>>();
const leases = new Map<string, WikiRunsControlStoreLease>();
const activityLeases = new Map<string, WorkspaceActivityLease>();
const inFlightOperations = new Map<string, Set<Promise<void>>>();
const retiredWorkspaceIdsByRoot = new Map<string, string>();

/** A request holding an old Workspace snapshot raced with workspace deletion. */
export class WikiRunsWorkspaceDeletedError extends Error {
  readonly code = "workspace_deleted";
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`workspace deleted: ${workspaceId}`);
    this.name = "WikiRunsWorkspaceDeletedError";
    this.workspaceId = workspaceId;
  }
}

async function assertWorkspaceAvailable(workspace: WorkspaceConfig): Promise<void> {
  const retiredId = retiredWorkspaceIdsByRoot.get(workspace.rootPath);
  if (retiredId === workspace.id) throw new WikiRunsWorkspaceDeletedError(workspace.id);
  // A fresh Workspace at the same filesystem root has a different immutable id.
  if (retiredId !== undefined) retiredWorkspaceIdsByRoot.delete(workspace.rootPath);
  try {
    await assertWorkspaceActive(workspace.rootPath);
  } catch (error) {
    if (error instanceof WorkspaceDeletedError || error instanceof WorkspaceLifecycleInUseError) {
      throw new WikiRunsWorkspaceDeletedError(workspace.id);
    }
    throw error;
  }
  if (retiredWorkspaceIdsByRoot.get(workspace.rootPath) === workspace.id) {
    throw new WikiRunsWorkspaceDeletedError(workspace.id);
  }
}

/**
 * Return the WikiRuns owner for this workspace root.
 * Records the latest Workspace config only for newly started Runs. Existing
 * Runs use their durable freeze config rather than a warm-owner hot swap.
 */
export async function wikiRunsForWorkspace(workspace: WorkspaceConfig): Promise<WikiRuns> {
  const owner = await wikiRunsOwnerForWorkspace(workspace);
  return guardWikiRuns(workspace, owner);
}

async function wikiRunsOwnerForWorkspace(workspace: WorkspaceConfig): Promise<WikiRuns> {
  const key = workspace.rootPath;
  await assertWorkspaceAvailable(workspace);
  const existing = owners.get(key);
  if (existing) {
    existing.setWorkspaceForNewRuns(workspace);
    return existing;
  }

  const pending = opening.get(key);
  if (pending) {
    const runs = await pending;
    await assertWorkspaceAvailable(workspace);
    runs.setWorkspaceForNewRuns(workspace);
    return runs;
  }

  const fixture = shouldUsePiFixtureMode({});
  const owner = (async () => {
    const activityLease = await acquireWorkspaceActivityLease(workspace.rootPath, workspace.id);
    let lease: WikiRunsControlStoreLease | undefined;
    let opened: WikiRuns | undefined;
    getLogger().info(
      {
        event: "workflow.owner.open",
        workspaceId: workspace.id,
        rootPath: workspace.rootPath,
        fixture,
      },
      "opening WikiRuns owner",
    );
    try {
      lease = await acquireWikiRunsControlStoreLease(workspace.rootPath);
      const runs = await openWikiRuns({
        rootPath: workspace.rootPath,
        piAttemptExecutor: createPiAttemptExecutor({ fixture }),
      });
      opened = runs;
      runs.setWorkspaceForNewRuns(workspace);
      await assertWorkspaceAvailable(workspace);
      owners.set(key, runs);
      leases.set(key, lease);
      activityLeases.set(key, activityLease);
      return runs;
    } catch (error) {
      getLogger().error(
        {
          event: "workflow.owner.open",
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
          err: error instanceof Error ? error.message : String(error),
        },
        "WikiRuns owner open failed",
      );
      if (opened) await opened.close().catch(() => undefined);
      if (lease) await lease.release();
      await activityLease.release();
      throw error;
    }
  })().finally(() => opening.delete(key));
  opening.set(key, owner);
  const runs = await owner;
  await assertWorkspaceAvailable(workspace);
  return runs;
}

/**
 * A request-level activity lease keeps DELETE from closing a WikiRuns owner
 * underneath an already-authorized call. The persistent owner lease still
 * coordinates ownership across Server processes.
 */
async function withWikiRunsOperation<T>(
  workspace: WorkspaceConfig,
  operation: () => Promise<T>,
): Promise<T> {
  await assertWorkspaceAvailable(workspace);
  const activityLease = await acquireWorkspaceActivityLease(workspace.rootPath, workspace.id);
  const workspaceKey = workspace.rootPath;
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const operations = inFlightOperations.get(workspaceKey) ?? new Set<Promise<void>>();
  operations.add(completion);
  inFlightOperations.set(workspaceKey, operations);
  try {
    await assertWorkspaceAvailable(workspace);
    return await operation();
  } finally {
    try {
      await activityLease.release();
    } finally {
      resolveCompletion();
      operations.delete(completion);
      if (operations.size === 0) inFlightOperations.delete(workspaceKey);
    }
  }
}

function guardWikiRuns(workspace: WorkspaceConfig, owner: WikiRuns): WikiRuns {
  return new Proxy(owner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) =>
        withWikiRunsOperation(workspace, async () => Reflect.apply(value, target, args));
    },
  });
}

/**
 * Establish a deletion fence and fully close one workspace owner before its
 * metadata can be removed. Pending opens are awaited so no SQLite lease or
 * attempt survives the deletion boundary.
 */
export async function closeWikiRunsForDeletedWorkspace(workspace: WorkspaceConfig): Promise<void> {
  const key = workspace.rootPath;
  retiredWorkspaceIdsByRoot.set(key, workspace.id);

  const pending = opening.get(key);
  if (pending) await pending.catch(() => undefined);
  const operations = inFlightOperations.get(key);
  if (operations) await Promise.all([...operations]);

  const owner = owners.get(key);
  const lease = leases.get(key);
  const activityLease = activityLeases.get(key);
  owners.delete(key);
  leases.delete(key);
  activityLeases.delete(key);
  if (owner) {
    getLogger().info(
      { event: "workflow.owner.close", workspaceId: workspace.id, rootPath: workspace.rootPath },
      "closing deleted workspace WikiRuns owner",
    );
  }
  try {
    if (owner) await owner.close();
  } finally {
    if (lease) await lease.release();
    if (activityLease) await activityLease.release();
  }
}

/** Reopen the request boundary when workspace deletion fails before removal. */
export function restoreWikiRunsAfterFailedWorkspaceDeletion(workspace: WorkspaceConfig): void {
  if (retiredWorkspaceIdsByRoot.get(workspace.rootPath) === workspace.id) {
    retiredWorkspaceIdsByRoot.delete(workspace.rootPath);
  }
}

/** Close all SQLite owners during Server shutdown (or focused tests). */
export async function closeWikiRuns(): Promise<void> {
  await Promise.all([...opening.values()].map((owner) => owner.catch(() => undefined)));
  await Promise.all([...inFlightOperations.values()].flatMap((operations) => [...operations]));
  const live = [...owners.values()];
  const heldLeases = [...leases.values()];
  const heldActivityLeases = [...activityLeases.values()];
  const count = live.length;
  owners.clear();
  leases.clear();
  activityLeases.clear();
  if (count > 0) {
    getLogger().info({ event: "workflow.owner.close", count }, "closing WikiRuns owners");
  }
  try {
    await Promise.all(live.map((owner) => owner.close()));
  } finally {
    await Promise.all(heldLeases.map((lease) => lease.release()));
    await Promise.all(heldActivityLeases.map((lease) => lease.release()));
    retiredWorkspaceIdsByRoot.clear();
  }
}

export const resetWikiRunsRegistryForTests = closeWikiRuns;
