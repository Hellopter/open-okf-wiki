import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireWorkspaceActivityLease,
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

test("Workspace DELETE requires the current revision before removing its index entry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-workspace-delete-route-"));
  const workspace = await createWorkspace({
    name: "Revisioned delete",
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

  const missing = await fetch(endpoint, { method: "DELETE" });
  assert.equal(missing.status, 400, await missing.clone().text());

  const updated = await fetch(endpoint, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 0, name: "Changed before deletion" }),
  });
  assert.equal(updated.status, 200, await updated.clone().text());

  const stale = await fetch(`${endpoint}?expectedRevision=0`, { method: "DELETE" });
  assert.equal(stale.status, 409, await stale.clone().text());

  const deleted = await fetch(`${endpoint}?expectedRevision=1`, { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  const deleteBody = (await deleted.json()) as { deletedMeta: boolean };
  assert.equal(deleteBody.deletedMeta, false);

  const gone = await fetch(endpoint);
  assert.equal(gone.status, 404, await gone.clone().text());
});

test("Workspace DELETE refuses metadata removal while another process is active", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-workspace-delete-active-"));
  const workspace = await createWorkspace({
    name: "Active workspace deletion",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
  });
  await saveWorkspace(workspace);
  await registerWorkspaceInAppIndex(root);
  const activity = await acquireWorkspaceActivityLease(root, workspace.id);

  const server = createServer((req, res) => void dispatch(req, res));
  t.after(async () => {
    await activity.release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    await removeWorkspaceFromAppIndex(root);
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/api/workspaces/${workspace.id}`;

  const deleted = await fetch(`${endpoint}?expectedRevision=0&deleteFiles=true`, {
    method: "DELETE",
  });
  assert.equal(deleted.status, 409, await deleted.clone().text());
  const stillThere = await fetch(endpoint);
  assert.equal(stillThere.status, 200, await stillThere.clone().text());
});
