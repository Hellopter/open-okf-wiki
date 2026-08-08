import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWikiCore } from "@okf-wiki/wiki-agent-kit";

const runtime = {
  kind: "pi",
  extension: "@okf-wiki/pi-wiki-agent",
  workflow: { id: "repository-wiki", digest: `sha256:${"a".repeat(64)}` },
};

function quality(title) {
  return `# ${title}\n\nVerdict: PASS\nAffected pages: None\nFindings: None\nRequired repair: None\n`;
}

async function fixture(dependencies) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-kit-"));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "package.json"), '{"name":"fixture"}\n');
  await writeFile(path.join(source, "src", "index.js"), "export const answer = 42;\n");
  const core = createWikiCore(dependencies);
  await core.initializeWorkspace(root, { runtime });
  await core.addLinkedSource(root, { path: source, id: "fixture" });
  return { core, root };
}

test("compiled public core owns an async run lifecycle", async () => {
  const { core, root } = await fixture();
  const run = await core.prepareRun(root);
  assert.equal(run.state.status, "planning");
  assert.ok(run.methodDir.endsWith("/method"));
  assert.ok(run.mainSessionDir.endsWith("/analysis/session"));

  await writeFile(run.planPath, "# Plan\n\n## Page Matrix\n\n| Page | Coverage Units | Evidence Brief | Diagram |\n| --- | --- | --- | --- |\n| `concepts/example.md` | `fixture` | `analysis/evidence/example.md` | omitted |\n");
  await writeFile(path.join(run.evidenceDir, "example.md"), "inputs/sources/fixture/src/index.js#L1-L1\n");
  await writeFile(run.coverageReviewPath, quality("Coverage"));
  await writeFile(run.qualityReportPaths["coverage-rereview"], quality("Coverage re-review"));

  const session = await core.recordMainSession(root, { runId: run.runId, mainSessionPath: path.join(run.mainSessionDir, "main.jsonl") });
  assert.equal(session.mainSessionPath, "analysis/session/main.jsonl");
  const proposal = await core.completeRunPlanning(root, { runId: run.runId });
  assert.equal(proposal.state.status, "proposed");
  assert.equal(proposal.state.mainSessionPath, "analysis/session/main.jsonl");
  const approved = await core.approveRun(root, { runId: run.runId, planDigest: proposal.planDigest });
  assert.equal(approved.resumeAt, "write");

  await mkdir(path.join(run.bundleDir, "concepts"), { recursive: true });
  await writeFile(path.join(run.bundleDir, "concepts", "example.md"), "---\ntype: concept\ntitle: Example\nsources:\n  - id: fixture\n    resource: inputs/sources/fixture/src/index.js#L1-L1\n---\n\n[Source](../../inputs/sources/fixture/src/index.js#L1-L1)\n");
  await Promise.all(Object.entries(run.qualityReportPaths).filter(([id]) => id !== "coverage-rereview").map(([, file]) => writeFile(file, quality("Final review"))));
  const validated = await core.validateRunBundle(root, { runId: run.runId });
  assert.equal(validated.ok, true, validated.errors.join("; "));
  assert.equal(validated.state.status, "complete");
  assert.match(await readFile(path.join(run.bundleDir, "index.md"), "utf8"), /okf_version/);
});

test("orchestration claims use one named owner and release only that owner", async () => {
  const { core, root } = await fixture();
  const run = await core.prepareRun(root);
  assert.equal((await core.claimRun(root, { runId: run.runId, orchestrationId: "orchestration-1" })).claimed, true);
  await assert.rejects(core.claimRun(root, { runId: run.runId, orchestrationId: "orchestration-1" }), /already claimed/);
  await assert.rejects(core.releaseRun(root, { runId: run.runId, orchestrationId: "orchestration-2" }), /not owned/);
  assert.deepEqual(await core.releaseRun(root, { runId: run.runId, orchestrationId: "orchestration-1" }), { released: true });
});

test("concurrent claim attempts admit exactly one owner", async () => {
  const { core, root } = await fixture();
  const run = await core.prepareRun(root);
  const results = await Promise.allSettled([
    core.claimRun(root, { runId: run.runId, orchestrationId: "orchestration-a" }),
    core.claimRun(root, { runId: run.runId, orchestrationId: "orchestration-b" }),
  ]);
  const winner = results.find((result) => result.status === "fulfilled");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(winner.status, "fulfilled");
  await core.releaseRun(root, { runId: run.runId, orchestrationId: winner.value.orchestrationId });
});

test("a restarted core reclaims only a dead owner's durable lock", async () => {
  const { core, root } = await fixture();
  const run = await core.prepareRun(root);
  await core.claimRun(root, { runId: run.runId, orchestrationId: "crashed-orchestration" });

  const restartedCore = createWikiCore({ isProcessAlive: () => false });
  const recovered = await restartedCore.claimRun(root, { runId: run.runId, orchestrationId: "restarted-orchestration" });

  assert.equal(recovered.claimed, true);
  assert.equal(recovered.orchestrationId, "restarted-orchestration");
  await assert.rejects(core.releaseRun(root, { runId: run.runId, orchestrationId: "crashed-orchestration" }), /not owned/);
  assert.deepEqual(await restartedCore.releaseRun(root, { runId: run.runId, orchestrationId: "restarted-orchestration" }), { released: true });
});

test("a permission-denied liveness check conservatively retains the owner lock", async () => {
  const { core, root } = await fixture();
  const run = await core.prepareRun(root);
  await core.claimRun(root, { runId: run.runId, orchestrationId: "protected-orchestration" });
  const restrictedCore = createWikiCore({
    isProcessAlive: () => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); },
  });

  await assert.rejects(
    restrictedCore.claimRun(root, { runId: run.runId, orchestrationId: "restarted-orchestration" }),
    /already claimed/,
  );
  await core.releaseRun(root, { runId: run.runId, orchestrationId: "protected-orchestration" });
});
