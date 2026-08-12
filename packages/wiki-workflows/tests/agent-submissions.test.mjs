import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_STAGING_MUTATIONS,
  MAX_QUERY_RESULT_BYTES,
  MAX_SUBMISSIONS_PER_ATTEMPT,
  submissionFor,
  submissionTools,
  seedSynthesisPlan,
  researchCatalogTools,
} from "../dist/agent-submissions.js";
import { workflowTools } from "../dist/agent-tools.js";
import { validateResearchReceiptRouting } from "../dist/research-receipt.js";

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
  const tools = new Map(submissionTools(policy(), collector).map((tool) => [tool.name, tool]));
  const stage = tools.get("wiki_review_put_defects");
  const tool = tools.get("wiki_submit_review");
  assert.equal(tool.name, "wiki_submit_review");
  assert.doesNotMatch(JSON.stringify(tool.parameters), /artifactPath/);

  const rejected = await stage.execute("bad", {
    defects: [{ slot: "coverage", defect: { kind: "coverage", page: "core/domain.md", detail: "Wrong branch shape." } }],
  });
  assert.equal(rejected.details.ok, false);
  assert.match(rejected.details.message, /unsupported field: page/);
  assert.equal(rejected.terminate, false);

  await stage.execute("fixed", { defects: [{ slot: "depth", defect: { kind: "depth", page: "core/domain.md", detail: "Add details." } }] });
  const removed = await tools.get("wiki_review_remove_defect").execute("remove", { slot: "depth" });
  assert.deepEqual({ removed: removed.details.removed, stagedDefects: removed.details.stagedDefects }, { removed: true, stagedDefects: 0 });
  await stage.execute("replacement", { defects: [{ slot: "link", defect: { kind: "link", page: "core/domain.md", detail: "Repair the link." } }] });
  const queried = await tools.get("wiki_review_defects").execute("query", {});
  assert.equal(queried.details.total, 1);
  const accepted = await tool.execute("fixed", { summary: "Complete." });
  assert.equal(accepted.details.accepted, true);
  assert.equal(accepted.terminate, true);
  assert.deepEqual(collector.value, { defects: [{ kind: "link", page: "core/domain.md", detail: "Repair the link." }], summary: "Complete." });
  assert.equal(collector.submissionAttempts, 1);
  assert.equal(collector.mutationCount, 3);
  assert.match(tool.description, /Submit only the summary/);
});

test("the third invalid direct submission exhausts the node attempt", async () => {
  const collector = submissionFor(request());
  const tool = submissionTools(policy(), collector).find((candidate) => candidate.name === "wiki_submit_review");
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
  const tool = submissionTools(policy(), collector).find((candidate) => candidate.name === "wiki_submit_review");
  const result = await tool.execute("bad", { defects: [], summary: " " });
  assert.equal(result.details.remainingAttempts, 0);
  assert.equal(result.details.exhausted, true);
  assert.equal(result.terminate, true);
  assert.equal(collector.maxSubmissions, 1);
});

test("synthesis exposes separate expand and finalize tools with one shared budget", async () => {
  const collector = submissionFor(request("synthesis"));
  const tools = submissionTools(policy(), collector);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()], ["wiki_plan_put_domain", "wiki_plan_remove_domain", "wiki_plan_set_coordination", "wiki_spec_get_domain", "wiki_submission_status", "wiki_submit_synthesis_expand", "wiki_submit_synthesis_finalize"]);
  const expand = byName.get("wiki_submit_synthesis_expand");
  const finalize = byName.get("wiki_submit_synthesis_finalize");
  assert.doesNotMatch(JSON.stringify(expand.parameters), /"spec"|"decision"/);
  assert.doesNotMatch(JSON.stringify(finalize.parameters), /"researchScopes"|"decision"|"spec"/);
  assert.match(finalize.description, /Submit only the rationale/);
  assert.doesNotMatch(finalize.promptGuidelines.join("\n"), /complete result object/i);

  const rejected = await expand.execute("bad-expand", { researchScopes: [], rationale: "Missing evidence." });
  assert.equal(rejected.details.remainingAttempts, 2);
  for (const domain of planDomains()) await byName.get("wiki_plan_put_domain").execute(`put-${domain.id}`, { domain });
  const status = await byName.get("wiki_submission_status").execute("status", {});
  assert.deepEqual(status.details.domains, ["overview", "core"]);
  assert.equal(collector.submissionAttempts, 1, "staging and query do not spend terminal attempts");
  const accepted = await finalize.execute("finalize", { rationale: "Complete." });
  assert.equal(accepted.details.accepted, true);
  assert.equal(collector.value.decision, "finalize");
  assert.equal(collector.submissionAttempts, 2);
});

test("concurrent synthesis tools accept exactly one decision", async () => {
  const collector = submissionFor(request("synthesis"));
  const tools = new Map(submissionTools(policy(), collector).map((tool) => [tool.name, tool]));
  for (const domain of planDomains()) await tools.get("wiki_plan_put_domain").execute(`put-${domain.id}`, { domain });
  const results = await Promise.all([
    tools.get("wiki_submit_synthesis_expand").execute("expand", { researchScopes: [{ id: "gap", sourcePaths: ["src"], task: "Resolve gap" }], rationale: "Need evidence." }),
    tools.get("wiki_submit_synthesis_finalize").execute("finalize", { rationale: "Complete." }),
  ]);
  assert.equal(results.filter((result) => result.details.accepted).length, 1);
  assert.equal(results.filter((result) => !result.details.accepted && result.details.issues[0].code === "already_accepted").length, 1);
  assert.equal(collector.submissionAttempts, 1);
  assert.equal(collector.failure, undefined);
  assert.equal(collector.exhausted, false);
  assert.equal(collector.value.decision, collector.acceptedToolName === "wiki_submit_synthesis_expand" ? "expand" : "finalize");
});

function planDomains() {
  return [
    { id: "overview", title: "Overview", purpose: "Orient", pages: [{ pageType: "overview", path: "overview/overview.md", title: "Overview", purpose: "Orient", readerQuestions: ["What exists?"], requiredFacets: ["domain map"], findingIds: [] }] },
    { id: "core", title: "Core", purpose: "Core domain", pages: [{ pageType: "domain", path: "core/domain.md", title: "Core", purpose: "Explain core", readerQuestions: ["How does core fit together?"], requiredFacets: ["models", "flows", "state", "invariants", "boundaries"], findingIds: ["finding-core"] }] },
  ];
}

test("research slot upserts assemble the canonical terminal artifact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-research-stage-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(path.join(root, "src"), { recursive: true }).then(() => writeFile(path.join(root, "src/core.ts"), "export const core = true;\n")));
  const collector = submissionFor(request("research"));
  const tools = new Map(submissionTools(policy(root), collector, { allowedSourceRoots: ["src"] }).map((tool) => [tool.name, tool]));
  const finding = { kind: "concept", title: "Core", readerQuestion: "What is core?", priority: "normal", evidence: ["src/core.ts#L1"] };
  await tools.get("wiki_research_put_findings").execute("put-1", { findings: [{ slot: "core", finding }] });
  await tools.get("wiki_research_put_findings").execute("put-2", { findings: [{ slot: "core", finding: { ...finding, title: "Core API" } }] });
  await tools.get("wiki_research_put_findings").execute("put-transient", { findings: [{ slot: "transient", finding: { ...finding, kind: "flow" } }] });
  const removed = await tools.get("wiki_research_remove_finding").execute("remove-transient", { slot: "transient" });
  assert.deepEqual({ removed: removed.details.removed, stagedFindings: removed.details.stagedFindings }, { removed: true, stagedFindings: 1 });
  const queried = await tools.get("wiki_research_findings").execute("query", {});
  assert.equal(queried.details.total, 1);
  assert.equal(queried.details.findings[0].finding.title, "Core API");
  assert.equal(collector.submissionAttempts, 0);
  const accepted = await tools.get("wiki_submit_research").execute("submit", { summary: "Complete.", gaps: [] });
  assert.equal(accepted.details.accepted, true);
  assert.equal(collector.value.findings.length, 1);
  const submit = tools.get("wiki_submit_research");
  assert.match(submit.description, /Submit only the final summary and gaps/);
  assert.doesNotMatch(submit.promptGuidelines.join("\n"), /complete result object/i);
});

test("oversized research routing is rejected and repaired in the same session", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-research-receipt-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "src"), { recursive: true }));
  const scope = { id: "scope-1", task: "Survey", sourcePaths: ["src"] };
  const collector = submissionFor({
    ...request("research"),
    maxSubmissionAttempts: 2,
    validateControlSubmission: (value) => validateResearchReceiptRouting(value, scope),
  });
  const submit = submissionTools(policy(root), collector, { allowedSourceRoots: ["src"] })
    .find((tool) => tool.name === "wiki_submit_research");

  const rejected = await submit.execute("large", {
    summary: "Needs repair.",
    gaps: [{ question: "x".repeat(62 * 1024), priority: "critical", sourcePaths: ["src"] }],
  });
  assert.equal(rejected.details.accepted, false);
  assert.equal(rejected.terminate, false);
  assert.match(rejected.details.issues[0].message, /routing exceeds 61440 UTF-8 bytes/);

  const accepted = await submit.execute("fixed", { summary: "Complete.", gaps: [] });
  assert.equal(accepted.details.accepted, true);
  assert.equal(accepted.terminate, true);
  assert.equal(collector.submissionAttempts, 2);
});

test("plan domain queries paginate and byte-bound model-facing results", async () => {
  const collector = submissionFor(request("synthesis"));
  const tools = new Map(submissionTools(policy(), collector).map((tool) => [tool.name, tool]));
  const domain = {
    id: "large",
    title: "Large",
    purpose: "Large staged domain",
    pages: Array.from({ length: 15 }, (_, index) => ({
      pageType: index === 0 ? "domain" : "module",
      path: index === 0 ? "large/domain.md" : `large/module-${index}.md`,
      title: `Page ${index}`,
      purpose: "x".repeat(3_000),
      readerQuestions: [`Question ${index}?`],
      requiredFacets: index === 0 ? ["models", "flows", "state", "invariants", "boundaries"] : ["interface"],
      findingIds: [`finding-${index}`],
    })),
  };
  assert.equal((await tools.get("wiki_plan_put_domain").execute("put", { domain })).details.ok, true);
  const first = await tools.get("wiki_spec_get_domain").execute("get", { domainId: "large", pageLimit: 20 });
  assert.ok(Buffer.byteLength(first.content[0].text, "utf8") <= MAX_QUERY_RESULT_BYTES);
  assert.equal(first.details.truncated, true);
  assert.ok(first.details.nextOffset > 0);
  assert.ok(first.details.domain.pages.length < domain.pages.length);
  const second = await tools.get("wiki_spec_get_domain").execute("get-next", {
    domainId: "large", pageOffset: first.details.nextOffset, pageLimit: 20,
  });
  assert.ok(Buffer.byteLength(second.content[0].text, "utf8") <= MAX_QUERY_RESULT_BYTES);
  assert.equal(second.details.pageOffset, first.details.nextOffset);
});

test("query pagination omits one oversized page while advancing and bounds domain metadata", async () => {
  const collector = submissionFor(request("synthesis"));
  const tools = new Map(submissionTools(policy(), collector).map((tool) => [tool.name, tool]));
  const huge = "界".repeat(20_000);
  const page = {
    pageType: "domain", path: "huge/domain.md", title: "Huge", purpose: huge,
    readerQuestions: ["What is huge?"], requiredFacets: ["models", "flows", "state", "invariants", "boundaries"], findingIds: [],
  };
  await tools.get("wiki_plan_put_domain").execute("put-page", {
    domain: { id: "huge-page", title: "Huge page", purpose: "Test one page", pages: [page] },
  });
  const oversizedPage = await tools.get("wiki_spec_get_domain").execute("get-page", { domainId: "huge-page" });
  assert.ok(Buffer.byteLength(oversizedPage.content[0].text, "utf8") <= MAX_QUERY_RESULT_BYTES);
  assert.equal(oversizedPage.details.oversizedItemOmitted, true);
  assert.equal(oversizedPage.details.omittedOffset, 0);
  assert.equal(oversizedPage.details.nextOffset, 1);

  await tools.get("wiki_plan_put_domain").execute("put-metadata", {
    domain: { id: "huge-metadata", title: huge, purpose: huge, pages: [{ ...page, purpose: "Small" }] },
  });
  const boundedMetadata = await tools.get("wiki_spec_get_domain").execute("get-metadata", { domainId: "huge-metadata" });
  assert.ok(Buffer.byteLength(boundedMetadata.content[0].text, "utf8") <= MAX_QUERY_RESULT_BYTES);
  assert.equal(boundedMetadata.details.metadataTruncated, true);
  assert.match(boundedMetadata.details.domain.title, /\[truncated\]$/);
  assert.match(boundedMetadata.details.domain.purpose, /\[truncated\]$/);
});

test("staging mutation budget is separate from terminal attempts", async () => {
  const collector = submissionFor(request("synthesis"));
  const tools = new Map(submissionTools(policy(), collector).map((tool) => [tool.name, tool]));
  for (let index = 0; index < MAX_STAGING_MUTATIONS; index += 1) {
    const result = await tools.get("wiki_plan_remove_domain").execute(`remove-${index}`, { domainId: `unused-${index}` });
    assert.equal(result.details.ok, true);
  }
  const exhausted = await tools.get("wiki_plan_remove_domain").execute("exhausted", { domainId: "unused" });
  assert.equal(exhausted.details.code, "mutation_budget_exhausted");
  assert.equal(exhausted.terminate, false);
  assert.equal(collector.submissionAttempts, 0);
  const terminal = await tools.get("wiki_submit_synthesis_expand").execute("expand", {
    researchScopes: [{ id: "gap", sourcePaths: ["src"], task: "Resolve gap" }], rationale: "Need evidence.",
  });
  assert.equal(terminal.details.accepted, true);
});

test("a synthesis collector can be preseeded from the prior finalized spec", async () => {
  const collector = submissionFor(request("synthesis"));
  seedSynthesisPlan(collector, { domains: planDomains(), crossLinks: [], sharedTerms: [], omissions: [] });
  const tools = new Map(submissionTools(policy(), collector).map((tool) => [tool.name, tool]));
  const domain = await tools.get("wiki_spec_get_domain").execute("get", { domainId: "core" });
  assert.equal(domain.details.domain.id, "core");
  const accepted = await tools.get("wiki_submit_synthesis_finalize").execute("finalize", { rationale: "Prior plan remains valid." });
  assert.equal(accepted.details.accepted, true);
});

test("read-only research catalog tools paginate and byte-bound findings", async () => {
  const catalog = [{
    scopeId: "core",
    task: "Explain core",
    sourcePaths: ["src"],
    gaps: [],
    findings: Array.from({ length: 20 }, (_, index) => ({
      id: `finding-${index}`,
      kind: "concept",
      title: `Finding ${index}`,
      readerQuestion: "x".repeat(2_000),
      priority: "normal",
      evidence: ["src/core.ts#L1"],
    })),
  }];
  const tools = new Map(researchCatalogTools(catalog).map((tool) => [tool.name, tool]));
  const scopes = await tools.get("wiki_research_scopes").execute("scopes", {});
  assert.deepEqual(scopes.details.scopes[0], { scopeId: "core", task: "Explain core", sourcePaths: ["src"], findingCount: 20, gapCount: 0 });
  const findings = await tools.get("wiki_research_findings").execute("findings", { limit: 20 });
  assert.ok(Buffer.byteLength(findings.content[0].text, "utf8") <= MAX_QUERY_RESULT_BYTES);
  assert.equal(findings.details.truncated, true);
  assert.ok(findings.details.nextOffset > 0);
});

test("catalog queries omit one oversized finding and advance pagination", async () => {
  const catalog = [{
    scopeId: "huge", task: "Explain huge", sourcePaths: ["src"], gaps: [],
    findings: [{
      id: "finding-huge", kind: "concept", title: "Huge", readerQuestion: "界".repeat(20_000),
      priority: "normal", evidence: ["src/core.ts#L1"],
    }],
  }];
  const tools = new Map(researchCatalogTools(catalog).map((tool) => [tool.name, tool]));
  const result = await tools.get("wiki_research_findings").execute("findings", { offset: 0, limit: 1 });
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= MAX_QUERY_RESULT_BYTES);
  assert.equal(result.details.oversizedItemOmitted, true);
  assert.equal(result.details.omittedOffset, 0);
  assert.equal(result.details.nextOffset, 1);
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
