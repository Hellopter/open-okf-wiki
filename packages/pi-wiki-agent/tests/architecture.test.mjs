import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWikiCore } from "@okf-wiki/wiki-agent-kit";
import {
  createWikiFilesystemTools,
  WIKI_WORKFLOW_DIGEST,
  WIKI_RUNTIME_DEFINITION,
  WIKI_WORKFLOW_PHASES,
  parseInventory,
  parseQualityReportText,
  resolveActiveOrchestrationId,
  WikiRunStore,
} from "../dist/index.js";

test("workflow digest derives from the complete phase specification", () => {
  assert.equal(WIKI_WORKFLOW_PHASES.length, 12);
  assert.ok(WIKI_WORKFLOW_PHASES.includes("Coverage verification"));
  assert.match(WIKI_WORKFLOW_DIGEST, /^sha256:[a-f0-9]{64}$/);
});

test("active orchestration selection favors active work and then recency", () => {
  const runs = [
    { orchestrationId: "old-active", overall: "paused", backend: "session", updatedAt: 1, workspaceRoot: "/a" },
    { orchestrationId: "new-complete", overall: "complete", backend: "session", updatedAt: 4, workspaceRoot: "/a" },
    { orchestrationId: "new-active", overall: "running", backend: "session", updatedAt: 3, workspaceRoot: "/a" },
  ];
  assert.equal(resolveActiveOrchestrationId(runs), "new-active");
  assert.equal(resolveActiveOrchestrationId(runs, "explicit"), "explicit");
});

test("observation store serializes disk writes and exposes only complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "okf-wiki-store-"));
  try {
    let tick = 10;
    const store = new WikiRunStore({ workspaceRoot: root, runId: "run-1", orchestrationId: "orch-1", now: () => ++tick });
    store.createRun({ workspaceRoot: root, runId: "run-1", orchestrationId: "orch-1", backend: "session", mode: "generate" });
    store.appendEvent("orch.started");
    store.appendEvent("phase.started", { phase: "Write" });
    store.appendEvent("phase.complete", { phase: "Write" });
    store.setOverall("complete");
    await store.flush();
    const snapshot = JSON.parse(await readFile(join(store.storeDir, "snapshot.json"), "utf8"));
    assert.equal(snapshot.orchestrationId, "orch-1");
    assert.equal(snapshot.overall, "complete");
    assert.deepEqual((await store.listEvents()).map((event) => event.seq), [1, 2, 3]);
    const reloaded = new WikiRunStore({ workspaceRoot: root, runId: "run-1" });
    assert.equal(await reloaded.load(), true);
    assert.equal(reloaded.getSnapshot().overall, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store flush reports persistence failures without dropping the first error", async () => {
  const root = await mkdtemp(join(tmpdir(), "okf-wiki-store-error-"));
  try {
    const blocked = join(root, ".wiki-agent", "runs", "run", "orchestration");
    await mkdir(join(root, ".wiki-agent", "runs", "run"), { recursive: true });
    await writeFile(blocked, "not a directory");
    const store = new WikiRunStore({ workspaceRoot: root, runId: "run", orchestrationId: "orch" });
    store.createRun({ workspaceRoot: root, runId: "run", orchestrationId: "orch", backend: "session", mode: "generate" });
    await assert.rejects(() => store.flush(), /not a directory|ENOTDIR|EEXIST/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planning parsers are deterministic pure functions", () => {
  const inventory = parseInventory({ sourceCount: 1, sources: [{ id: "api", fileCount: 2 }], coverageUnits: [{ id: "api:src", sourceId: "api", path: "src" }] });
  assert.equal(inventory.units[0].id, "api:src");
  const report = parseQualityReportText("review", "/review.md", "Verdict: PASS\nAffected pages: none\nFindings: none\nRequired repair: none\n");
  assert.equal(report.verdict, "PASS");
  assert.equal(report.findings, 0);
});

test("single tool policy permits Markdown handoffs and denies host state", async () => {
  const root = await mkdtemp(join(tmpdir(), "okf-wiki-tools-"));
  try {
    const core = createWikiCore();
    await core.initializeWorkspace(root, { runtime: WIKI_RUNTIME_DEFINITION, source: { type: "path", path: root } });
    const run = await core.prepareRun(root);
    const tools = createWikiFilesystemTools(root, core);
    const write = tools.find((tool) => tool.name === "write");
    const read = tools.find((tool) => tool.name === "read");
    await write.execute("plan", { path: run.planPath, content: "# Plan\n" });
    await assert.rejects(
      () => write.execute("state", { path: run.statePath, content: "{}" }),
      /cannot write|only author Markdown/,
    );
    await assert.rejects(() => read.execute("state", { path: run.statePath }), /host-owned/);
    const discoveryPath = join(run.discoveryDir, "sources", "service.md");
    await mkdir(join(run.discoveryDir, "sources"), { recursive: true });
    const sourceWrite = createWikiFilesystemTools(root, core, { role: "source-researcher" }).find((tool) => tool.name === "write");
    const reviewerWrite = createWikiFilesystemTools(root, core, { role: "reviewer-evidence" }).find((tool) => tool.name === "write");
    await sourceWrite.execute("source", { path: discoveryPath, content: "# Source\n" });
    await assert.rejects(() => reviewerWrite.execute("wrong-owner", { path: discoveryPath, content: "# Unsafe\n" }), /reviewer-evidence agent cannot (write|create)/);
    await assert.rejects(() => read.execute("escape", { path: tmpdir() }), /limited to the active Wiki run/);
    const outside = await mkdtemp(join(tmpdir(), "okf-wiki-outside-"));
    try {
      const link = join(run.bundleDir, "escape");
      await symlink(outside, link);
      await assert.rejects(
        () => write.execute("symlink", { path: join(link, "page.md"), content: "# Unsafe\n" }),
        /Symbolic links are not permitted/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const sealed = { ...core, async getRunState() { return { ...(await core.getRunState(root, { runId: run.runId })), status: "complete" }; } };
    const sealedWrite = createWikiFilesystemTools(root, sealed).find((tool) => tool.name === "write");
    await assert.rejects(() => sealedWrite.execute("sealed", { path: join(run.bundleDir, "page.md"), content: "# Sealed\n" }), /sealed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
