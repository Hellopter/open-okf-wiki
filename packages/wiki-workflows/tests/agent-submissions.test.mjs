import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SUBMISSIONS_PER_ATTEMPT,
  submissionFor,
  submissionTool,
} from "../dist/agent-submissions.js";
import { workflowTools } from "../dist/agent-tools.js";

function request(kind = "review") {
  return {
    node: { kind },
    role: kind === "review" ? "reviewer" : "synthesizer",
  };
}

function policy(root = process.cwd()) {
  return {
    workspaceRoot: root,
    sourceRoots: new Map(),
    wikiRoot: path.join(root, "wiki"),
    artifactRoot: path.join(root, ".okf-wiki"),
  };
}

test("control roles submit typed objects directly and repair semantic issues in-session", async () => {
  const collector = submissionFor(request());
  assert.ok(collector);
  const tool = submissionTool(policy(), collector);
  assert.equal(tool.name, "wiki_submit_review");
  assert.doesNotMatch(JSON.stringify(tool.parameters), /artifactPath/);

  const rejected = await tool.execute("bad", {
    defects: [{ kind: "coverage", page: "core/domain.md", detail: "Wrong branch shape." }],
    summary: "Needs correction.",
  });
  assert.deepEqual(rejected.details, {
    accepted: false,
    issues: [{
      path: "$.defects",
      code: "invalid_value",
      message: "Structural review defect contains unsupported field: page",
    }],
    remainingAttempts: 2,
    exhausted: false,
  });
  assert.equal(rejected.terminate, false);

  const accepted = await tool.execute("fixed", { defects: [], summary: "Complete." });
  assert.equal(accepted.details.accepted, true);
  assert.equal(accepted.terminate, true);
  assert.deepEqual(collector.value, { defects: [], summary: "Complete." });
});

test("the third invalid direct submission exhausts the node attempt", async () => {
  const collector = submissionFor(request());
  const tool = submissionTool(policy(), collector);
  let result;
  for (let attempt = 1; attempt <= MAX_SUBMISSIONS_PER_ATTEMPT; attempt += 1) {
    result = await tool.execute(`bad-${attempt}`, { defects: [], summary: " " });
    assert.equal(result.details.remainingAttempts, MAX_SUBMISSIONS_PER_ATTEMPT - attempt);
  }
  assert.deepEqual({ accepted: result.details.accepted, exhausted: result.details.exhausted, terminate: result.terminate }, {
    accepted: false,
    exhausted: true,
    terminate: true,
  });
  assert.equal(collector.exhausted, true);
  assert.equal(collector.submissionAttempts, MAX_SUBMISSIONS_PER_ATTEMPT);
});

test("the request pins a smaller direct submission budget per collector", async () => {
  const collector = submissionFor({ ...request(), maxSubmissionAttempts: 1 });
  const tool = submissionTool(policy(), collector);
  const result = await tool.execute("bad", { defects: [], summary: " " });
  assert.equal(result.details.remainingAttempts, 0);
  assert.equal(result.details.exhausted, true);
  assert.equal(result.terminate, true);
  assert.equal(collector.maxSubmissions, 1);
});

test("writer tools use the candidate Wiki root and cannot write the published Wiki", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-candidate-tools-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const candidateWikiRoot = path.join(root, ".run", "candidate", "wiki");
  const toolPolicy = { ...policy(root), candidateWikiRoot };
  const candidatePage = "wiki/core/domain.md";
  const tools = workflowTools(toolPolicy, "writer", undefined, [candidatePage]);
  const write = tools.find((tool) => tool.name === "write");
  assert.ok(write);

  await write.execute("candidate", { path: candidatePage, content: "# Candidate\n" });
  assert.equal(await readFile(path.join(candidateWikiRoot, "core/domain.md"), "utf8"), "# Candidate\n");
  await assert.rejects(() => readFile(path.join(root, "wiki/core/domain.md"), "utf8"), /ENOENT/);
  await assert.rejects(
    () => write.execute("unassigned", { path: "wiki/core/other.md", content: "# Other\n" }),
    /permitted workspace scope|not assigned/,
  );
});
