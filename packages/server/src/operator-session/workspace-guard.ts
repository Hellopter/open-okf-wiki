/**
 * Workspace availability fence and short-lived activity leases for Operator Sessions.
 */
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import {
  acquireWorkspaceActivityLease,
  assertWorkspaceActive,
  WorkspaceDeletedError,
  WorkspaceLifecycleInUseError,
} from "@okf-wiki/core";
import { type LiveSession, retiredWorkspaceIds } from "./registry.ts";

/** A request holding an old Workspace snapshot raced with workspace deletion. */
export class OperatorSessionWorkspaceDeletedError extends Error {
  readonly code = "workspace_deleted";
  readonly workspaceId: string;

  constructor(workspaceId: string) {
    super(`workspace deleted: ${workspaceId}`);
    this.name = "OperatorSessionWorkspaceDeletedError";
    this.workspaceId = workspaceId;
  }
}

export async function assertWorkspaceAvailable(workspace: WorkspaceConfig): Promise<void> {
  if (retiredWorkspaceIds.has(workspace.id)) {
    throw new OperatorSessionWorkspaceDeletedError(workspace.id);
  }
  try {
    await assertWorkspaceActive(workspace.rootPath);
  } catch (error) {
    if (error instanceof WorkspaceDeletedError || error instanceof WorkspaceLifecycleInUseError) {
      throw new OperatorSessionWorkspaceDeletedError(workspace.id);
    }
    throw error;
  }
  if (retiredWorkspaceIds.has(workspace.id)) {
    throw new OperatorSessionWorkspaceDeletedError(workspace.id);
  }
}

export async function assertLiveAvailable(workspace: WorkspaceConfig, live: LiveSession): Promise<void> {
  await assertWorkspaceAvailable(workspace);
  if (live.closed) throw new OperatorSessionWorkspaceDeletedError(workspace.id);
}

export async function withWorkspaceActivity<T>(
  workspace: WorkspaceConfig,
  operation: () => Promise<T>,
): Promise<T> {
  await assertWorkspaceAvailable(workspace);
  const lease = await acquireWorkspaceActivityLease(workspace.rootPath, workspace.id);
  try {
    await assertWorkspaceAvailable(workspace);
    return await operation();
  } finally {
    await lease.release();
  }
}
