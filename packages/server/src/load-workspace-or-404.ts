import type { ServerResponse } from "node:http";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { loadWorkspaceById } from "@okf-wiki/core";
import { sendError } from "./http-util.ts";

/**
 * Load a workspace by id or send 404 and return null.
 */
export async function loadWorkspaceOr404(
  res: ServerResponse,
  id: string,
): Promise<WorkspaceConfig | null> {
  const workspace = await loadWorkspaceById(id);
  if (!workspace) {
    sendError(res, 404, `workspace not found: ${id}`);
    return null;
  }
  return workspace;
}
