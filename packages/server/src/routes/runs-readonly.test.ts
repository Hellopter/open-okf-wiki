import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, registerWorkspaceInAppIndex, saveWorkspace } from "@okf-wiki/core";
import { dispatch } from "../dispatch.ts";
import { resetWikiRunsRegistryForTests } from "../wiki-runs-registry.ts";

test("Run HTTP list projects WikiRuns rows; graph route is gone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-runs-readonly-"));
  const workspace = await createWorkspace({
    name: "Read-only Run Surface",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  await registerWorkspaceInAppIndex(root);
  const server = createServer((req, res) => void dispatch(req, res));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const runs = `${base}/api/workspaces/${workspace.id}/runs`;

    const listEmpty = await fetch(runs);
    assert.equal(listEmpty.status, 200);
    assert.deepEqual(await listEmpty.json(), { workspaceId: workspace.id, runs: [] });

    // Observation graph route must stay deleted (WikiRuns GET is the snapshot).
    const missingGraph = await fetch(`${runs}/run-missing/graph`);
    assert.equal(missingGraph.status, 404);
    assert.deepEqual(await missingGraph.json(), { error: "not found" });

    const started = await fetch(`${runs}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "start_run",
        commandId: "list-start-1",
        intent: { mode: "generate" },
      }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    const receipt = (await started.json()) as { receipt: { runId: string; revision: number } };

    const list = await fetch(runs);
    assert.equal(list.status, 200, await list.clone().text());
    const listed = (await list.json()) as {
      workspaceId: string;
      runs: Array<{ runId: string; state: string; updatedAt: string; revision: number }>;
    };
    assert.equal(listed.workspaceId, workspace.id);
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0]?.runId, receipt.receipt.runId);
    assert.ok(listed.runs[0]?.state);
    assert.ok(listed.runs[0]?.updatedAt);
    assert.ok(typeof listed.runs[0]?.revision === "number");

    // GET /runs/:runId and /events are durable WikiRuns routes (ADR 0035).
    const got = await fetch(`${runs}/${receipt.receipt.runId}`);
    assert.equal(got.status, 200, await got.clone().text());
    const body = (await got.json()) as { snapshot: { runId: string } };
    assert.equal(body.snapshot.runId, receipt.receipt.runId);

    // Legacy Session-owned mutation / receipt routes must stay deleted.
    const removedRoutes: Array<[method: string, pathname: string]> = [
      ["POST", ""],
      ["POST", "/run-1/retry"],
      ["POST", "/run-1/approve-plan"],
      ["POST", "/run-1/deny-plan"],
      ["POST", "/run-1/revise-plan"],
      ["POST", "/run-1/approve-publication"],
      ["POST", "/run-1/deny-publication"],
      ["POST", "/run-1/cancel"],
      ["GET", "/run-1/receipts"],
      ["GET", "/run-1/graph"],
    ];

    for (const [method, pathname] of removedRoutes) {
      const response = await fetch(`${runs}${pathname}`, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      });
      assert.equal(response.status, 404, `${method} ${pathname || "/"}`);
      assert.deepEqual(await response.json(), { error: "not found" });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).catch(() => undefined);
    await resetWikiRunsRegistryForTests();
    await rm(root, { recursive: true, force: true });
  }
});
