import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createWikiFilesystemTools, createWikiHostTools } from "../dist/toolset.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-wiki-agent-"));
  const workdir = join(root, ".wiki-agent", "runs", "domain-1");
  const paths = {
    root,
    runId: "domain-1",
    workdir,
    inputsDir: join(workdir, "inputs"),
    sourcesDir: join(workdir, "sources"),
    methodDir: join(workdir, "method"),
    analysisDir: join(workdir, "analysis"),
    candidateDir: join(workdir, "candidate"),
  };
  await Promise.all([
    mkdir(paths.inputsDir, { recursive: true }),
    mkdir(paths.sourcesDir, { recursive: true }),
    mkdir(paths.methodDir, { recursive: true }),
    mkdir(join(paths.analysisDir, "receipts"), { recursive: true }),
    mkdir(paths.candidateDir, { recursive: true }),
  ]);
  return {
    root,
    paths,
    adapter: { getRunPaths: async () => paths },
  };
}

function toolText(result) {
  return (result?.content ?? []).map((part) => part.text ?? "").join("\n");
}

test("subagents have no shell and only write to the active run data plane", async () => {
  const { root, paths, adapter } = await fixture();
  const tools = createWikiFilesystemTools(root, adapter);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["edit", "find", "grep", "ls", "read", "write"]);
  const write = tools.find((tool) => tool.name === "write");

  await write.execute("test", { path: join(paths.analysisDir, "receipts", "ok.json"), content: "{}" });
  assert.equal(await readFile(join(paths.analysisDir, "receipts", "ok.json"), "utf8"), "{}");
  await assert.rejects(
    () => write.execute("test", { path: join(root, "workspace.yaml"), content: "unsafe" }),
    /data plane/,
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
  await assert.rejects(() => grep.execute("grep-escape", { pattern: "secret", path: outsideDir }), /inputs, sources, method, analysis, and candidate/);
  await assert.rejects(() => grep.execute("grep-escape-root", { pattern: "secret", path: root }), /inputs, sources, method, analysis, and candidate/);
  await assert.rejects(() => find.execute("find-escape", { pattern: "*", path: outsideDir }), /inputs, sources, method, analysis, and candidate/);
  await assert.rejects(() => find.execute("find-escape-root", { pattern: "*", path: root }), /inputs, sources, method, analysis, and candidate/);
  await assert.rejects(
    () => find.execute("find-escape-workdir", { pattern: "*", path: paths.workdir }),
    /inputs, sources, method, analysis, and candidate/,
  );
});

test("grep and find succeed under the active run sources directory", async () => {
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

  // Missing path defaults to sourcesDir.
  const defaultGrep = await grep.execute("grep-default", { pattern: unique });
  assert.match(toolText(defaultGrep), new RegExp(unique));
  const defaultFind = await find.execute("find-default", { pattern: "needle.md" });
  assert.match(toolText(defaultFind), /needle\.md/);
});

test("subagent host tools can inspect a plan gate but cannot approve it", async () => {
  let opened = 0;
  let checked = 0;
  const tools = createWikiHostTools("/workspace", {
    checkPlanGate: async () => {
      checked++;
      return { ok: false };
    },
    openPlanGate: async () => {
      opened++;
      return { ok: true };
    },
  });
  const gate = tools.find((tool) => tool.name === "okf_plan_gate_status");
  assert.ok(gate);
  assert.equal("action" in gate.parameters.properties, false);
  await gate.execute("gate", { runId: "domain-1", action: "open" });
  assert.equal(checked, 1);
  assert.equal(opened, 0);
});

test("review checkpoints reject the mutable defects state as an immutable artifact", async () => {
  const { root, paths, adapter } = await fixture();
  const artifactList = join(paths.analysisDir, "receipts", "review-artifacts-round-1.json");
  await writeFile(artifactList, JSON.stringify([{ id: "defects", type: "defects", path: "analysis/defects.json" }]));
  let published = 0;
  const tools = createWikiHostTools(root, {
    ...adapter,
    publishCheckpoint: async () => {
      published++;
      return { ok: true };
    },
  });
  const publish = tools.find((tool) => tool.name === "okf_publish");
  await assert.rejects(
    () => publish.execute("publish", { runId: paths.runId, phase: "review-1", artifactsJsonPath: "analysis/receipts/review-artifacts-round-1.json" }),
    /only immutable receipts under analysis\/receipts\/review\//,
  );
  assert.equal(published, 0);
});
