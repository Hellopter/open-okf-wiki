import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  await Promise.all([mkdir(paths.inputsDir, { recursive: true }), mkdir(join(paths.analysisDir, "receipts"), { recursive: true }), mkdir(paths.candidateDir, { recursive: true })]);
  return {
    root,
    paths,
    adapter: { getRunPaths: async () => paths },
  };
}

test("subagents have no shell and only write to the active run data plane", async () => {
  const { root, paths, adapter } = await fixture();
  const tools = createWikiFilesystemTools(root, adapter);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["edit", "ls", "read", "write"]);
  const write = tools.find((tool) => tool.name === "write");

  await write.execute("test", { path: join(paths.analysisDir, "receipts", "ok.json"), content: "{}" });
  assert.equal(await readFile(join(paths.analysisDir, "receipts", "ok.json"), "utf8"), "{}");
  await assert.rejects(
    () => write.execute("test", { path: join(root, "workspace.yaml"), content: "unsafe" }),
    /data plane/,
  );
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
