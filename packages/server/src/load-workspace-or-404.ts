import type { ServerResponse } from "node:http";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { loadWorkspaceById } from "@okf-wiki/core";
import { sendError } from "./http-util.ts";

/**
 * Load a workspace by id (optional rootPath query) or send 404 and return null.
 * Shared by HTTP route handlers; registry internal reload may call loadWorkspaceById directly.
 */
export async function loadWorkspaceOr404(
  res: ServerResponse,
  id: string,
  url: URL,
): Promise<WorkspaceConfig | null> {
  const workspace = await loadWorkspaceById(id, {
    rootPath: url.searchParams.get("rootPath") ?? undefined,
  });
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return null;
  }
  return workspace;
}
