import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";
import { loadSpecFromArtifact } from "./dag.js";

test("loadSpecFromArtifact accepts only the canonical sealed spec.json payload", async (t) => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "okf-workflow-spec-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const runId = "run-1";
  const artifact = path.join(rootPath, ".okf-wiki", "runs", runId, "artifacts", "spec");
  await mkdir(path.join(artifact, "analysis"), { recursive: true });
  await writeFile(
    path.join(artifact, "analysis", "spec.json"),
    `${JSON.stringify(defaultWikiRunSpec("ignored"))}\n`,
  );

  const host = { workspace: { rootPath } as WorkspaceConfig };
  assert.equal(loadSpecFromArtifact(host, runId, "artifacts/spec"), undefined);

  const expected = defaultWikiRunSpec("canonical");
  await writeFile(path.join(artifact, "spec.json"), `${JSON.stringify(expected)}\n`);
  assert.deepEqual(loadSpecFromArtifact(host, runId, "artifacts/spec"), expected);
});
