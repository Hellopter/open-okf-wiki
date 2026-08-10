import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { createWikiRunHistoryStore, wikiHistoryProjectKey } from "../dist/run-history.js";

function snapshot(id, status, updatedAt) {
  return {
    version: 4,
    id,
    cwd: "/workspace",
    requestedMode: "generate",
    effectiveMode: "generate",
    language: "zh",
    status,
    round: 0,
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
      metrics: {},
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

  await store.save(first);
  await store.save(second);
  assert.deepEqual((await store.list()).map((item) => item.id), ["second", "first"]);

  const loaded = await store.load("first");
  loaded.nodes[0].label = "Changed in memory";
  assert.equal((await store.load("first")).nodes[0].label, "Inspect Git scope");
  assert.equal(await store.delete("first"), true);
  assert.equal(await store.load("first"), undefined);
  assert.match(store.getRunsDir(), /runs$/);
});

test("retention evicts only the oldest terminal history and its artifacts", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-retention-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const artifacts = createWikiArtifactStore({ workspace: "/workspace", rootDir: path.join(rootDir, "artifacts") });
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir, maxTerminalRuns: 2, artifactStore: artifacts });

  await store.save(snapshot("old", "succeeded", "2026-08-01T00:00:00.000Z"));
  await artifacts.write({ runId: "old", nodeId: "inspect", attempt: 1, kind: "inspection", content: "{}" });
  await store.save(snapshot("middle", "failed", "2026-08-02T00:00:00.000Z"));
  await store.save(snapshot("new", "cancelled", "2026-08-03T00:00:00.000Z"));
  await store.save(snapshot("live", "running", "2026-08-04T00:00:00.000Z"));

  assert.deepEqual((await store.list()).map((item) => item.id), ["live", "new", "middle"]);
  assert.equal(await store.load("old"), undefined);
  assert.equal(await artifacts.removeRun("old"), false, "retention already removed the evicted run's artifacts");
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

test("history accepts only v4 snapshots", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-history-version-"));
  t.after(async () => await rm(rootDir, { recursive: true, force: true }));
  const store = createWikiRunHistoryStore({ workspace: "/workspace", rootDir });
  const runsDir = store.getRunsDir();
  await mkdir(runsDir, { recursive: true });
  await writeFile(
    path.join(runsDir, "legacy.json"),
    `${JSON.stringify({ ...snapshot("legacy", "succeeded", "2026-08-08T00:00:00.000Z"), version: 3 })}\n`,
    "utf8",
  );
  assert.equal(await store.load("legacy"), undefined);
  assert.deepEqual(await store.list(), []);
});
