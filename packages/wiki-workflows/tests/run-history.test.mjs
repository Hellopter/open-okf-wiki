import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { resolveWikiPolicy, wikiPolicyHash } from "../dist/policy.js";
import { createWikiRunHistoryStore, wikiHistoryProjectKey } from "../dist/run-history.js";

function metrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    compactions: 0,
    autoRetries: 0,
  };
}

function snapshot(id, status, updatedAt) {
  const policy = resolveWikiPolicy();
  return {
    version: 10,
    id,
    cwd: "/workspace",
    requestedMode: "generate",
    effectiveMode: "generate",
    language: "zh",
    status,
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    policy,
    policyHash: wikiPolicyHash(policy),
    nodes: [{
      id: "inspect",
      kind: "inspect",
      label: "Inspect Git scope",
      status: status === "failed" ? "failed" : "succeeded",
      dependsOn: [],
      attempt: 1,
      inputFingerprint: "input",
      input: {},
      attemptHistory: [],
      metrics: metrics(),
      activity: { state: "completed", updatedAt },
    }],
    events: [],
    createdAt: updatedAt,
    updatedAt,
    completedAt: status === "running" ? undefined : updatedAt,
  };
}

test("project-scoped run history persists complete snapshots and supports deletion", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir });
  const first = snapshot("first", "succeeded", "2026-08-08T00:00:00.000Z");
  const second = snapshot("second", "failed", "2026-08-09T00:00:00.000Z");
  const zeta = snapshot("zeta", "succeeded", "2026-08-09T00:00:00.000Z");

  await store.save(first);
  await store.save(second);
  await store.save(zeta);
  assert.deepEqual((await store.list()).map((item) => item.id), ["zeta", "second", "first"]);

  const loaded = await store.load("first");
  loaded.nodes[0].label = "Changed in memory";
  assert.equal((await store.load("first")).nodes[0].label, "Inspect Git scope");
  assert.equal(await store.delete("first"), true);
  assert.equal(await store.load("first"), undefined);
  assert.match(store.getRunsDir(), /runs$/);
  assert.equal(JSON.parse(await readFile(path.join(rootDir, "runs", "second", "run.json"), "utf8")).id, "second");
  assert.deepEqual(JSON.parse(await readFile(path.join(rootDir, "runs", "index.json"), "utf8")).summaries.map((item) => item.id), ["zeta", "second"]);
});

test("default history is authoritative below the workspace and listing is paginated and bounded", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-workspace-history-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace });
  for (let index = 0; index < 105; index += 1) {
    await store.save(snapshot(`run-${String(index).padStart(3, "0")}`, "running", `2026-08-09T00:${String(index).padStart(2, "0")}:00.000Z`));
  }
  assert.equal(store.getRunsDir(), path.join(workspace, ".okf-wiki", "runs"));
  const first = await store.listPage({ limit: 1000 });
  assert.equal(first.items.length, 100);
  assert.equal(first.total, 105);
  assert.equal(first.nextOffset, 100);
  const second = await store.listPage({ offset: first.nextOffset, limit: 10 });
  assert.equal(second.items.length, 5);
  assert.equal(second.nextOffset, undefined);
});

test("history repairs a stale summary index from the authoritative run snapshot", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-repair-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir });
  await store.save(snapshot("changed", "running", "2026-08-08T00:00:00.000Z"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(
    path.join(rootDir, "runs", "changed", "run.json"),
    `${JSON.stringify(snapshot("changed", "succeeded", "2026-08-09T00:00:00.000Z"))}\n`,
    "utf8",
  );
  // A fresh process has no in-memory list cache and must detect the stale index.
  const reopened = createWikiRunHistoryStore({ workspace: "/workspace", rootDir });
  assert.equal((await reopened.list())[0].status, "succeeded");
  assert.equal((await reopened.list())[0].updatedAt, "2026-08-09T00:00:00.000Z");
});

test("retention evicts only the oldest terminal history and its artifacts", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-retention-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const artifacts = createWikiArtifactStore({ workspace: "/workspace", rootDir: path.join(rootDir, "artifacts") });
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir, maxTerminalRuns: 2, artifactStore: artifacts });

  await store.save(snapshot("old", "succeeded", "2026-08-01T00:00:00.000Z"));
  await artifacts.write({ runId: "old", nodeId: "inspect", attempt: 1, kind: "inspection", content: "{}" });
  await writeFile(path.join(rootDir, "runs", "old", "publish.json"), '{"state":"rolled_back"}\n', "utf8");
  await store.save(snapshot("middle", "failed", "2026-08-02T00:00:00.000Z"));
  await store.save(snapshot("new", "cancelled", "2026-08-03T00:00:00.000Z"));
  await store.save(snapshot("live", "running", "2026-08-04T00:00:00.000Z"));

  assert.deepEqual((await store.list()).map((item) => item.id), ["live", "new", "middle"]);
  assert.equal(await store.load("old"), undefined);
  assert.equal(await artifacts.removeRun("old"), false, "retention already removed the evicted run's artifacts");
  assert.equal(await readFile(path.join(rootDir, "runs", "old", "publish.json"), "utf8"), '{"state":"rolled_back"}\n');
});

test("deleting history removes its workspace-local artifacts", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-artifact-delete-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const artifacts = createWikiArtifactStore({ workspace: "/workspace", rootDir: path.join(rootDir, "artifacts") });
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir, artifactStore: artifacts });
  await store.save(snapshot("completed", "succeeded", "2026-08-08T00:00:00.000Z"));
  await artifacts.write({ runId: "completed", nodeId: "inspect", attempt: 1, kind: "inspection", content: "{}" });

  assert.equal(await store.delete("completed"), true);
  assert.equal(await artifacts.removeRun("completed"), false, "history deletion already removed artifacts");
  assert.match(store.getArtifactsRoot(), /artifacts$/);
});

test("history deletion removes only history and artifacts, preserving publication recovery state", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-publish-state-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace });
  const runRoot = path.join(workspace, ".okf-wiki", "runs", "recoverable");
  await store.save({ ...snapshot("recoverable", "failed", "2026-08-08T00:00:00.000Z"), cwd: workspace });
  await mkdir(path.join(runRoot, "publish-backup"), { recursive: true });
  await writeFile(path.join(runRoot, "publish.json"), '{"state":"backed_up"}\n', "utf8");
  await writeFile(path.join(runRoot, "publish-backup", "overview.md"), "old wiki\n", "utf8");

  assert.equal(await store.delete("recoverable"), true);
  await assert.rejects(readFile(path.join(runRoot, "run.json"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(runRoot, "publish.json"), "utf8"), '{"state":"backed_up"}\n');
  assert.equal(await readFile(path.join(runRoot, "publish-backup", "overview.md"), "utf8"), "old wiki\n");
});

test("history rejects symbolic-link store and run directories", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-symlink-"));
  t.after(async () => await rm(fixtureRoot, { recursive: true, force: true }));
  const outside = path.join(fixtureRoot, "outside");
  await mkdir(outside);

  const linkedRoot = path.join(fixtureRoot, "linked-root");
  await symlink(outside, linkedRoot, "dir");
  const rootStore = createWikiRunHistoryStore({ workspace: fixtureRoot, rootDir: linkedRoot });
  await assert.rejects(
    rootStore.save(snapshot("escaped", "succeeded", "2026-08-08T00:00:00.000Z")),
    /regular directory/,
  );

  const safeRoot = path.join(fixtureRoot, "safe-root");
  const runStore = createWikiRunHistoryStore({ workspace: fixtureRoot, rootDir: safeRoot });
  await mkdir(path.join(safeRoot, "runs"), { recursive: true });
  await runStore.save(snapshot("file-link", "succeeded", "2026-08-08T00:00:00.000Z"));
  const outsideSnapshot = path.join(outside, "run.json");
  const linkedSnapshot = path.join(safeRoot, "runs", "file-link", "run.json");
  await writeFile(outsideSnapshot, `${JSON.stringify(snapshot("file-link", "succeeded", "2026-08-08T00:00:00.000Z"))}\n`, "utf8");
  await rm(linkedSnapshot);
  await symlink(outsideSnapshot, linkedSnapshot, "file");
  await assert.rejects(runStore.load("file-link"), /regular file/);

  await symlink(outside, path.join(safeRoot, "runs", "escaped"), "dir");
  await assert.rejects(
    runStore.save(snapshot("escaped", "succeeded", "2026-08-08T00:00:00.000Z")),
    /regular directory/,
  );
  await assert.rejects(runStore.load("escaped"), /regular directory/);
});

test("project keys are stable and avoid collisions between similarly named paths", () => {
  assert.equal(wikiHistoryProjectKey("/projects/docs"), wikiHistoryProjectKey("/projects/docs"));
  assert.notEqual(wikiHistoryProjectKey("/projects/docs"), wikiHistoryProjectKey("/other/docs"));
});

test("history never treats a run ID as a filesystem path", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-id-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir });
  await assert.rejects(() => store.save(snapshot("../outside", "succeeded", "2026-08-08T00:00:00.000Z")), /Invalid Wiki run history identifier/);
});

test("history accepts only complete current snapshots and rejects older versions", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-version-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir });
  const runsDir = store.getRunsDir();
  await mkdir(runsDir, { recursive: true });
  const writeRawRun = async (id, value) => {
    await mkdir(path.join(runsDir, id), { recursive: true });
    await writeFile(path.join(runsDir, id, "run.json"), `${JSON.stringify(value)}\n`, "utf8");
  };
  await writeRawRun(
    "legacy",
    { ...snapshot("legacy", "succeeded", "2026-08-08T00:00:00.000Z"), version: 5 },
  );
  await writeRawRun(
    "legacy-v6",
    { ...snapshot("legacy-v6", "succeeded", "2026-08-08T00:00:00.000Z"), version: 6 },
  );
  const missingRestartCount = snapshot("incomplete", "succeeded", "2026-08-08T00:00:00.000Z");
  delete missingRestartCount.sourceRestartCount;
  await writeRawRun("incomplete", missingRestartCount);
  const invalidNode = { ...snapshot("invalid-node", "succeeded", "2026-08-08T00:00:00.000Z"), nodes: [null] };
  await writeRawRun("invalid-node", invalidNode);
  const invalidRound = { ...snapshot("invalid-round", "succeeded", "2026-08-08T00:00:00.000Z"), round: -1 };
  await writeRawRun("invalid-round", invalidRound);
  const invalidStatus = { ...snapshot("invalid-status", "succeeded", "2026-08-08T00:00:00.000Z"), status: "done" };
  await writeRawRun("invalid-status", invalidStatus);
  assert.equal(await store.load("legacy"), undefined);
  assert.equal(await store.load("legacy-v6"), undefined);
  assert.equal(await store.load("incomplete"), undefined);
  assert.equal(await store.load("invalid-node"), undefined);
  assert.equal(await store.load("invalid-round"), undefined);
  assert.equal(await store.load("invalid-status"), undefined);
  assert.deepEqual(await store.list(), []);
});
