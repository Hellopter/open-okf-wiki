import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createWorkspace,
  registerWorkspaceInAppIndex,
  removeWorkspaceFromAppIndex,
  saveWorkspace,
} from "@okf-wiki/core";
import { dispatch } from "../dispatch.ts";

test("Workspace PATCH serializes revisioned writes and returns the authoritative conflict state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-workspace-route-"));
  const workspace = await createWorkspace({
    name: "Revisioned HTTP Workspace",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(workspace);
  await registerWorkspaceInAppIndex(root);

  const server = createServer((req, res) => void dispatch(req, res));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await removeWorkspaceFromAppIndex(root);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}`;

  const first = await fetch(endpoint, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, name: "Saved once" }),
  });
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = (await first.json()) as { workspace: { revision: number; name: string } };
  assert.equal(firstBody.workspace.revision, 1);
  assert.equal(firstBody.workspace.name, "Saved once");

  const stale = await fetch(endpoint, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, name: "Lost update" }),
  });
  assert.equal(stale.status, 409, await stale.clone().text());
  const staleBody = (await stale.json()) as {
    error: string;
    details: {
      code: string;
      expectedRevision: number;
      workspace: { revision: number; name: string };
    };
  };
  assert.equal(staleBody.error, "workspace revision conflict");
  assert.equal(staleBody.details.code, "stale_revision");
  assert.equal(staleBody.details.expectedRevision, 0);
  assert.equal(staleBody.details.workspace.revision, 1);
  assert.equal(staleBody.details.workspace.name, "Saved once");
});
