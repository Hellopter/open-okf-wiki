import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace, registerWorkspaceInAppIndex, saveWorkspace } from "@okf-wiki/core";
import { dispatch } from "../dispatch.ts";

test("wiki list returns page summaries and wiki-graph returns the link graph", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-wiki-routes-"));
  const publication = path.join(root, "published");
  await mkdir(path.join(publication, "modules"), { recursive: true });
  await writeFile(
    path.join(publication, "overview.md"),
    [
      "---",
      "type: Overview",
      "title: Overview",
      "description: The big picture.",
      'generated: { by: "okf-wiki/test", at: "2026-07-26T12:00:00Z" }',
      'verified: { by: "process:review-council", at: "2026-07-26T12:30:00Z" }',
      "---",
      "",
      "See [core](modules/core.md) and [missing](missing.md).",
    ].join("\n"),
  );
  await writeFile(
    path.join(publication, "modules/core.md"),
    "---\ntype: Module\ntitle: Core\ndescription: Core module.\n---\n\nBack to [overview](../overview.md).\n",
  );
  await writeFile(path.join(publication, "index.md"), "# Wiki\n\n* [Overview](overview.md) - o\n");

  const workspace = await createWorkspace({
    name: "Wiki Routes",
    rootPath: root,
    orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
    publicationPath: publication,
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
    const list = await fetch(`${base}/api/workspaces/${workspace.id}/wiki`);
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      pages: string[];
      summaries: Array<{ path: string; type?: string; title?: string; description?: string }>;
      nav: Array<{ kind: string; path?: string; title?: string; children?: unknown[] }>;
    };
    assert.deepEqual(listBody.pages, ["index.md", "modules/core.md", "overview.md"]);
    const overviewSummary = listBody.summaries.find((s) => s.path === "overview.md");
    assert.deepEqual(overviewSummary, {
      path: "overview.md",
      type: "Overview",
      title: "Overview",
      description: "The big picture.",
    });
    // Reserved listing has no concept frontmatter.
    assert.deepEqual(
      listBody.summaries.find((s) => s.path === "index.md"),
      { path: "index.md" },
    );
    // Nav follows index.md order; reserved index is not a leaf; orphan core is Unlisted.
    assert.ok(Array.isArray(listBody.nav) && listBody.nav.length >= 1);
    const firstPage = listBody.nav.find((n) => n.kind === "page" || n.kind === "group");
    assert.ok(firstPage);
    // Flatten page paths from nav
    const navPaths: string[] = [];
    const walk = (nodes: typeof listBody.nav) => {
      for (const n of nodes) {
        if (n.kind === "page" && n.path) navPaths.push(n.path);
        if (Array.isArray(n.children)) walk(n.children as typeof listBody.nav);
      }
    };
    walk(listBody.nav);
    assert.ok(navPaths.includes("overview.md"));
    assert.ok(navPaths.includes("modules/core.md"));
    assert.ok(!navPaths.includes("index.md"));

    const graphRes = await fetch(`${base}/api/workspaces/${workspace.id}/wiki-graph`);
    assert.equal(graphRes.status, 200);
    const graph = (await graphRes.json()) as {
      workspaceId: string;
      nodes: Array<{ path: string; trustTier: string; generatedBy?: string }>;
      edges: Array<{ from: string; to: string }>;
      brokenLinks: Array<{ from: string; resolved?: string }>;
    };
    assert.equal(graph.workspaceId, workspace.id);
    assert.deepEqual(graph.nodes.map((n) => n.path).sort(), ["modules/core.md", "overview.md"]);
    assert.equal(graph.nodes.find((n) => n.path === "overview.md")!.trustTier, "machine-confirmed");
    assert.deepEqual(graph.edges.map((e) => `${e.from}>${e.to}`).sort(), [
      "modules/core.md>overview.md",
      "overview.md>modules/core.md",
    ]);
    assert.deepEqual(
      graph.brokenLinks.map((b) => b.resolved),
      ["missing.md"],
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
