/** One long-lived WikiRuns owner per workspace root for this Server process. */
import { createPiAttemptExecutor, shouldUsePiFixtureMode } from "@okf-wiki/agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { openWikiRuns, type WikiRuns } from "@okf-wiki/workflow";

const owners = new Map<string, WikiRuns>();
const opening = new Map<string, Promise<WikiRuns>>();

export async function wikiRunsForWorkspace(workspace: WorkspaceConfig): Promise<WikiRuns> {
  const key = workspace.rootPath;
  const existing = owners.get(key);
  if (existing) return existing;

  const pending = opening.get(key);
  if (pending) return pending;

  const fixture = shouldUsePiFixtureMode({});
  const owner = openWikiRuns({
    rootPath: workspace.rootPath,
    piAttemptExecutor: createPiAttemptExecutor({ fixture }),
  })
    .then((runs) => {
      owners.set(key, runs);
      return runs;
    })
    .finally(() => opening.delete(key));
  opening.set(key, owner);
  return owner;
}

/** Close all SQLite owners during Server shutdown (or focused tests). */
export async function closeWikiRuns(): Promise<void> {
  await Promise.all([...opening.values()].map((owner) => owner.catch(() => undefined)));
  const live = [...owners.values()];
  owners.clear();
  await Promise.all(live.map((owner) => owner.close()));
}

export const resetWikiRunsRegistryForTests = closeWikiRuns;
