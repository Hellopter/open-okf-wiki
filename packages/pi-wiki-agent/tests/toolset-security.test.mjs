import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createWikiFilesystemTools, createWikiHostTools } from "../dist/toolset.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-wiki-agent-"));
  const runDir = join(root, ".wiki-agent", "runs", "domain-1");
  const paths = {
    root,
    runId: "domain-1",
    inputsDir: join(runDir, "inputs"),
    sourcesDir: join(runDir, "inputs", "sources"),
    analysisDir: join(runDir, "analysis"),
    bundleDir: join(runDir, "bundle"),
    sessionDir: join(runDir, "analysis", "session"),
  };
  await Promise.all([
    mkdir(paths.sourcesDir, { recursive: true }),
    mkdir(join(runDir, "method"), { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(join(paths.analysisDir, "discovery"), { recursive: true }),
    mkdir(paths.bundleDir, { recursive: true }),
  ]);
  return {
    root,
    paths,
    adapter: {
      getRunPaths: async () => paths,
      getRunState: async () => ({ runId: paths.runId, status: "planning" }),
    },
  };
}

function toolText(result) {
  return (result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

test("subagents have no shell and only write Markdown handoffs or the active bundle", async () => {
  const { root, paths, adapter } = await fixture();
  const tools = createWikiFilesystemTools(root, adapter);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["edit", "find", "grep", "ls", "read", "write"]);
  const write = tools.find((tool) => tool.name === "write");
  const read = tools.find((tool) => tool.name === "read");

  const plan = join(paths.analysisDir, "plan.md");
  const discovery = join(paths.analysisDir, "discovery", "identity.md");
  const page = join(paths.bundleDir, "domains", "identity", "overview.md");
  await write.execute("plan", { path: plan, content: "# Plan\n" });
  await write.execute("bundle", { path: page, content: "---\ntype: domain\ntitle: Identity\nsources:\n  - id: app-readme\n    resource: inputs/sources/app/README.md#L1-L1\n---\n" });
  assert.equal(await readFile(plan, "utf8"), "# Plan\n");
  assert.match(await readFile(page, "utf8"), /type: domain/);

  await assert.rejects(() => write.execute("state", { path: join(paths.analysisDir, "state.json"), content: "{}" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("run-lock", { path: join(paths.analysisDir, "run.lock.json"), content: "{}" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("inventory", { path: join(paths.analysisDir, "inventory.md"), content: "unsafe" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("session", { path: join(paths.sessionDir, "session.json"), content: "unsafe" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("input", { path: join(paths.inputsDir, "run-policy.json"), content: "unsafe" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("outside", { path: join(root, "workspace.yaml"), content: "unsafe" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("discovery", { path: discovery, content: "unsafe" }), /main agent cannot (write|create)/);
  await assert.rejects(() => write.execute("bundle-json", { path: join(paths.bundleDir, "draft.json"), content: "{}" }), /only author Markdown/);
  await assert.rejects(() => write.execute("index", { path: join(paths.bundleDir, "index.md"), content: "unsafe" }), /host-owned/);
  await assert.rejects(() => write.execute("nested-index", { path: join(paths.bundleDir, "domains", "identity", "index.md"), content: "unsafe" }), /host-owned/);
  await assert.rejects(() => read.execute("state-read", { path: join(paths.analysisDir, "state.json") }), /host-owned/);
  await assert.rejects(() => read.execute("run-lock-read", { path: join(paths.analysisDir, "run.lock.json") }), /host-owned/);
  await assert.rejects(() => read.execute("manifest-read", { path: join(paths.analysisDir, "bundle.manifest.json") }), /host-owned/);
  await assert.rejects(() => read.execute("session-read", { path: join(paths.sessionDir, "main.jsonl") }), /host-owned/);
});

test("role-scoped tools enforce independent discovery and review handoff ownership", async () => {
  const { root, paths, adapter } = await fixture();
  const discovery = createWikiFilesystemTools(root, adapter, { role: "discover" }).find((tool) => tool.name === "write");
  const coverage = createWikiFilesystemTools(root, adapter, { role: "coverage-critic" }).find((tool) => tool.name === "write");
  const reviewer = createWikiFilesystemTools(root, adapter, { role: "reviewer" }).find((tool) => tool.name === "write");

  await discovery.execute("discover", { path: join(paths.analysisDir, "discovery", "identity.md"), content: "# Discovery\n" });
  await coverage.execute("coverage", { path: join(paths.analysisDir, "coverage-review.md"), content: "# Coverage Review\n" });
  await reviewer.execute("review", { path: join(paths.analysisDir, "review.md"), content: "# Review\n" });

  await assert.rejects(
    () => discovery.execute("discover-plan", { path: join(paths.analysisDir, "plan.md"), content: "unsafe" }),
    /discover agent cannot (write|create)/,
  );
  await assert.rejects(
    () => discovery.execute("discover-json", { path: join(paths.analysisDir, "discovery", "identity.json"), content: "{}" }),
    /only author Markdown/,
  );
  await assert.rejects(
    () => coverage.execute("coverage-bundle", { path: join(paths.bundleDir, "concepts", "identity.md"), content: "unsafe" }),
    /coverage-critic agent cannot (write|create)/,
  );
  await assert.rejects(
    () => reviewer.execute("review-coverage", { path: join(paths.analysisDir, "coverage-review.md"), content: "unsafe" }),
    /reviewer agent cannot write/,
  );
});

test("grep and find cannot search outside the active run data plane", async () => {
  const { root, paths, adapter } = await fixture();
  const tools = createWikiFilesystemTools(root, adapter);
  const grep = tools.find((tool) => tool.name === "grep");
  const find = tools.find((tool) => tool.name === "find");
  assert.ok(grep);
  assert.ok(find);

  const outsideDir = dirname(root);
  await assert.rejects(() => grep.execute("grep-escape", { pattern: "secret", path: outsideDir }), /inputs, method, analysis, and bundle/);
  await assert.rejects(() => grep.execute("grep-escape-root", { pattern: "secret", path: root }), /inputs, method, analysis, and bundle/);
  await assert.rejects(() => find.execute("find-escape", { pattern: "*", path: outsideDir }), /inputs, method, analysis, and bundle/);
  await assert.rejects(() => find.execute("find-escape-root", { pattern: "*", path: root }), /inputs, method, analysis, and bundle/);
});

test("grep and find default to frozen sources", async () => {
  const { root, paths, adapter } = await fixture();
  const unique = `wiki-search-token-${Date.now()}-xyzzy`;
  const sourceFile = join(paths.sourcesDir, "needle.md");
  await writeFile(sourceFile, `# Source\n\nThis file contains ${unique} for search tests.\n`, "utf8");

  const tools = createWikiFilesystemTools(root, adapter);
  const grep = tools.find((tool) => tool.name === "grep");
  const find = tools.find((tool) => tool.name === "find");

  const grepResult = await grep.execute("grep-ok", { pattern: unique, path: paths.sourcesDir });
  assert.match(toolText(grepResult), new RegExp(unique));

  const findResult = await find.execute("find-ok", { pattern: "needle.md", path: paths.sourcesDir });
  assert.match(toolText(findResult), /needle\.md/);

  const defaultGrep = await grep.execute("grep-default", { pattern: unique });
  assert.match(toolText(defaultGrep), new RegExp(unique));
  const defaultFind = await find.execute("find-default", { pattern: "needle.md" });
  assert.match(toolText(defaultFind), /needle\.md/);
});

test("agent host tools can inspect run state but cannot mutate a run", async () => {
  let queried = 0;
  const tools = createWikiHostTools("/workspace", {
    getRunState: async () => {
      queried++;
      return { runId: "domain-1", status: "proposed" };
    },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["okf_run_status"]);
  const status = tools[0];
  const result = await status.execute("status", { runId: "domain-1" });
  assert.equal(queried, 1);
  assert.match(toolText(result), /proposed/);
});

test("sealed runs deny further bundle or handoff writes", async () => {
  const { root, paths, adapter } = await fixture();
  adapter.getRunState = async () => ({ runId: paths.runId, status: "complete" });
  const write = createWikiFilesystemTools(root, adapter).find((tool) => tool.name === "write");
  await assert.rejects(
    () => write.execute("sealed", { path: join(paths.bundleDir, "concepts", "identity.md"), content: "unsafe" }),
    /sealed/,
  );
});
