import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { emptyRunGraphSnapshot } from "@okf-wiki/contract";
import {
  createWorkspace,
  saveWorkspace,
  writeRunGraph,
} from "@okf-wiki/core";
import { dispatch } from "../dispatch.ts";

test("Run HTTP surface exposes only the Agent Workspace read model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-runs-readonly-"));
  const workspace = await createWorkspace({
    name: "Read-only Run Surface",
    rootPath: root,
    publicationPath: path.join(root, "published"),
    resolvedModelId: "openai/test",
  });
  await saveWorkspace(workspace);
  const server = createServer((req, res) => void dispatch(req, res));

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const query = `rootPath=${encodeURIComponent(root)}`;
    const runs = `${base}/api/workspaces/${workspace.id}/runs`;

    const list = await fetch(`${runs}?${query}`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { workspaceId: workspace.id, runs: [] });

    // Durable Run Graph GET (read-only observation)
    const missingGraph = await fetch(`${runs}/run-missing/graph?${query}`);
    assert.equal(missingGraph.status, 404);

    const graph = emptyRunGraphSnapshot(1);
    graph.topology = [{ nodeKey: "plan", kind: "plan", label: "Plan" }];
    await writeRunGraph(root, "run-1", graph);
    const got = await fetch(`${runs}/run-1/graph?${query}`);
    assert.equal(got.status, 200);
    const body = (await got.json()) as {
      workspaceId: string;
      runId: string;
      graph: { topologyVersion: number; topology: unknown[] };
    };
    assert.equal(body.workspaceId, workspace.id);
    assert.equal(body.runId, "run-1");
    assert.equal(body.graph.topologyVersion, 1);
    assert.equal(body.graph.topology.length, 1);

    const removedRoutes: Array<[method: string, pathname: string]> = [
      ["POST", ""],
      ["GET", "/run-1"],
      ["POST", "/run-1/retry"],
      ["POST", "/run-1/approve-plan"],
      ["POST", "/run-1/deny-plan"],
      ["POST", "/run-1/revise-plan"],
      ["POST", "/run-1/approve-publication"],
      ["POST", "/run-1/deny-publication"],
      ["POST", "/run-1/cancel"],
      ["GET", "/run-1/events"],
      ["GET", "/run-1/receipts"],
    ];

    for (const [method, pathname] of removedRoutes) {
      const response = await fetch(`${runs}${pathname}?${query}`, {
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
    await rm(root, { recursive: true, force: true });
  }
});
