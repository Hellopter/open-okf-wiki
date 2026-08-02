/** One long-lived WikiRuns owner per workspace root for this Server process. */
import { createPiAttemptExecutor, shouldUsePiFixtureMode } from "@okf-wiki/agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { openWikiRuns, type WikiRuns } from "@okf-wiki/workflow";
import { getLogger } from "./logging/index.ts";

const owners = new Map<string, WikiRuns>();
const opening = new Map<string, Promise<WikiRuns>>();

/**
 * Return the WikiRuns owner for this workspace root.
 * Records the latest Workspace config only for newly started Runs. Existing
 * Runs use their durable freeze config rather than a warm-owner hot swap.
 */
export async function wikiRunsForWorkspace(workspace: WorkspaceConfig): Promise<WikiRuns> {
  const key = workspace.rootPath;
  const existing = owners.get(key);
  if (existing) {
    existing.setWorkspaceForNewRuns(workspace);
    return existing;
  }

  const pending = opening.get(key);
  if (pending) {
    const runs = await pending;
    runs.setWorkspaceForNewRuns(workspace);
    return runs;
  }

  const fixture = shouldUsePiFixtureMode({});
  getLogger().info(
    {
      event: "workflow.owner.open",
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      fixture,
    },
    "opening WikiRuns owner",
  );
  const owner = openWikiRuns({
    rootPath: workspace.rootPath,
    piAttemptExecutor: createPiAttemptExecutor({ fixture }),
  })
    .then((runs) => {
      runs.setWorkspaceForNewRuns(workspace);
      owners.set(key, runs);
      return runs;
    })
    .catch((error) => {
      getLogger().error(
        {
          event: "workflow.owner.open",
          workspaceId: workspace.id,
          rootPath: workspace.rootPath,
          err: error instanceof Error ? error.message : String(error),
        },
        "WikiRuns owner open failed",
      );
      throw error;
    })
    .finally(() => opening.delete(key));
  opening.set(key, owner);
  return owner;
}

/** Close all SQLite owners during Server shutdown (or focused tests). */
export async function closeWikiRuns(): Promise<void> {
  await Promise.all([...opening.values()].map((owner) => owner.catch(() => undefined)));
  const live = [...owners.values()];
  const count = live.length;
  owners.clear();
  if (count > 0) {
    getLogger().info({ event: "workflow.owner.close", count }, "closing WikiRuns owners");
  }
  await Promise.all(live.map((owner) => owner.close()));
}

export const resetWikiRunsRegistryForTests = closeWikiRuns;
