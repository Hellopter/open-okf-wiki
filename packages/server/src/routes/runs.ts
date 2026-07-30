/**
 * Agent Workspace run list — slim WikiRuns projection (ADR 0035).
 *
 * Durable Run commands / SSE live on wiki-runs routes. This handler only lists
 * `{ runId, state, updatedAt, revision }` from the SQLite control plane.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactErrorMessage } from "@okf-wiki/agent";
import { WorkflowInUseError } from "@okf-wiki/workflow";
import { sendError, sendJson } from "../http-util.ts";
import { loadWorkspaceOr404 } from "../load-workspace-or-404.ts";
import { wikiRunsForWorkspace } from "../wiki-runs-registry.ts";

/** Agent Workspace read model: one row per durable WikiRun. */
export async function handleListRuns(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  _url: URL,
): Promise<void> {
  const workspace = await loadWorkspaceOr404(res, id);
  if (!workspace) return;
  try {
    const runs = await (await wikiRunsForWorkspace(workspace)).list();
    sendJson(res, 200, { workspaceId: workspace.id, runs });
  } catch (error) {
    const status = error instanceof WorkflowInUseError ? 409 : 500;
    sendError(res, status, redactErrorMessage(error));
  }
}
