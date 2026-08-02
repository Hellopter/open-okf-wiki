import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, deleteWorkspaceMeta, saveWorkspace } from "@okf-wiki/core";
import {
  closeWikiRunsForDeletedWorkspace,
  resetWikiRunsRegistryForTests,
  WikiRunsWorkspaceDeletedError,
  wikiRunsForWorkspace,
} from "./wiki-runs-registry.ts";

test("deleting a workspace closes its owner before metadata removal and fences old snapshots", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-registry-delete-"));
  const workspace = await createWorkspace({
    name: "Registry deletion",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(workspace);
  t.after(async () => {
    await resetWikiRunsRegistryForTests();
    await rm(root, { recursive: true, force: true });
  });

  await wikiRunsForWorkspace(workspace);
  await closeWikiRunsForDeletedWorkspace(workspace);
  await deleteWorkspaceMeta(root);

  await assert.rejects(
    () => wikiRunsForWorkspace(workspace),
    (error: unknown) => error instanceof WikiRunsWorkspaceDeletedError,
  );
  await assert.rejects(() => access(path.join(root, ".okf-wiki")));
});
