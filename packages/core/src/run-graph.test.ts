import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { emptyRunGraphSnapshot } from "@okf-wiki/contract";
import { analysisDir } from "./run-layout.js";
import { loadRunGraph, runGraphPath, writeRunGraph } from "./run-graph.js";

test("writeRunGraph / loadRunGraph round-trip under analysis/run-graph.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-run-graph-"));
  const snapshot = {
    topologyVersion: 1,
    topology: [
      { nodeKey: "plan", kind: "plan" as const, label: "Plan" },
      { nodeKey: "domain-core", kind: "domain" as const, label: "Core", parentKey: "plan" },
    ],
    attempts: [
      {
        attemptId: "plan-0",
        nodeKey: "plan",
        runIndex: 0,
        role: "plan" as const,
        status: "done" as const,
        summary: "planned",
      },
    ],
    playhead: { nodeKey: "plan", attemptId: "plan-0" },
  };

  const filePath = await writeRunGraph(root, "run-1", snapshot);
  assert.equal(filePath, runGraphPath(root, "run-1"));
  assert.equal(filePath, path.join(analysisDir(root, "run-1"), "run-graph.json"));

  const raw = JSON.parse(await readFile(filePath, "utf8")) as { topologyVersion: number };
  assert.equal(raw.topologyVersion, 1);

  const loaded = await loadRunGraph(root, "run-1");
  assert.ok(loaded);
  assert.equal(loaded!.topology.length, 2);
  assert.equal(loaded!.attempts[0]?.attemptId, "plan-0");
  assert.equal(loaded!.playhead?.nodeKey, "plan");
});

test("loadRunGraph returns null when missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-run-graph-miss-"));
  assert.equal(await loadRunGraph(root, "nope"), null);
});

test("writeRunGraph rejects invalid snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-run-graph-bad-"));
  await assert.rejects(
    () =>
      writeRunGraph(root, "run-x", {
        ...emptyRunGraphSnapshot(),
        attempts: [{ attemptId: "", nodeKey: "x", runIndex: 0, status: "done" }],
      } as never),
  );
});
