import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_SUBMISSIONS_PER_ATTEMPT,
  submissionFor,
  submissionTools,
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
  const [tool] = submissionTools(policy(), collector);
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
  const [tool] = submissionTools(policy(), collector);
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
  const [tool] = submissionTools(policy(), collector);
  const result = await tool.execute("bad", { defects: [], summary: " " });
  assert.equal(result.details.remainingAttempts, 0);
  assert.equal(result.details.exhausted, true);
  assert.equal(result.terminate, true);
  assert.equal(collector.maxSubmissions, 1);
});

test("synthesis exposes separate expand and finalize tools with one shared budget", async () => {
  const collector = submissionFor(request("synthesis"));
  const tools = submissionTools(policy(), collector);
  assert.deepEqual(tools.map((tool) => tool.name), ["wiki_submit_synthesis_expand", "wiki_submit_synthesis_finalize"]);
  assert.doesNotMatch(JSON.stringify(tools[0].parameters), /"spec"|"decision"/);
  assert.doesNotMatch(JSON.stringify(tools[1].parameters), /"researchScopes"|"decision"/);

  const rejected = await tools[0].execute("bad-expand", { researchScopes: [], rationale: "Missing evidence." });
  assert.equal(rejected.details.remainingAttempts, 2);
  const accepted = await tools[1].execute("finalize", {
    decision: "expand",
    spec: {
      domains: [
        { id: "overview", title: "Overview", purpose: "Orient", pages: [{ pageType: "overview", path: "overview/overview.md", title: "Overview", purpose: "Orient", readerQuestions: ["What exists?"], requiredFacets: ["domain map"], findingIds: [] }] },
        { id: "core", title: "Core", purpose: "Core domain", pages: [{ pageType: "domain", path: "core/domain.md", title: "Core", purpose: "Explain core", readerQuestions: ["How does core fit together?"], requiredFacets: ["models", "flows", "state", "invariants", "boundaries"], findingIds: ["finding-core"] }] },
      ], crossLinks: [], sharedTerms: [], omissions: [],
    },
    rationale: "Complete.",
  });
  assert.equal(accepted.details.accepted, true);
  assert.equal(collector.value.decision, "finalize");
  assert.equal(collector.submissionAttempts, 2);
});

test("concurrent synthesis tools accept exactly one decision", async () => {
  const collector = submissionFor(request("synthesis"));
  const [expand, finalize] = submissionTools(policy(), collector);
  const spec = {
    domains: [
      { id: "overview", title: "Overview", purpose: "Orient", pages: [{ pageType: "overview", path: "overview/overview.md", title: "Overview", purpose: "Orient", readerQuestions: ["What exists?"], requiredFacets: ["domain map"], findingIds: [] }] },
      { id: "core", title: "Core", purpose: "Core domain", pages: [{ pageType: "domain", path: "core/domain.md", title: "Core", purpose: "Explain core", readerQuestions: ["How does core fit together?"], requiredFacets: ["models", "flows", "state", "invariants", "boundaries"], findingIds: ["finding-core"] }] },
    ],
  };
  const results = await Promise.all([
    expand.execute("expand", { researchScopes: [{ id: "gap", sourcePaths: ["src"], task: "Resolve gap" }], rationale: "Need evidence." }),
    finalize.execute("finalize", { spec, rationale: "Complete." }),
  ]);
  assert.equal(results.filter((result) => result.details.accepted).length, 1);
  assert.equal(results.filter((result) => !result.details.accepted && result.details.issues[0].code === "already_accepted").length, 1);
  assert.equal(collector.submissionAttempts, 1);
  assert.equal(collector.failure, undefined);
  assert.equal(collector.exhausted, false);
  assert.equal(collector.value.decision, collector.acceptedToolName === "wiki_submit_synthesis_expand" ? "expand" : "finalize");
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
