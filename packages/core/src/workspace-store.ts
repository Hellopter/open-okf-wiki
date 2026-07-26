import type { WorkspaceConfig, WorkspaceSummary } from "@okf-wiki/contract";
import { listRecentWorkspaces } from "./workspace-app-state.js";
import { loadWorkspace } from "./workspace-config.js";

export type { WorkspaceSummary };

/** Load summaries for roots still present in the app index (skips broken entries). */
export async function listWorkspaceSummaries(appStatePath?: string): Promise<WorkspaceSummary[]> {
  const roots = await listRecentWorkspaces(appStatePath);
  const summaries: WorkspaceSummary[] = [];
  for (const root of roots) {
    try {
      const ws = await loadWorkspace(root);
      summaries.push({
        id: ws.id,
        name: ws.name,
        rootPath: ws.rootPath,
        lastOpenedAt: ws.lastOpenedAt,
        sourceCount: ws.sources.length,
      });
    } catch {
      // Stale index entry — skip
    }
  }
  return summaries;
}

/**
 * Resolve a workspace by id using the app index of recent roots.
 * Optionally accept an explicit rootPath query to avoid scanning.
 */
export async function loadWorkspaceById(
  id: string,
  options: { rootPath?: string; appStatePath?: string } = {},
): Promise<WorkspaceConfig | null> {
  if (options.rootPath) {
    try {
      const ws = await loadWorkspace(options.rootPath);
      return ws.id === id ? ws : null;
    } catch {
      return null;
    }
  }

  const roots = await listRecentWorkspaces(options.appStatePath);
  for (const root of roots) {
    try {
      const ws = await loadWorkspace(root);
      if (ws.id === id) {
        return ws;
      }
    } catch {
      // skip stale
    }
  }
  return null;
}
