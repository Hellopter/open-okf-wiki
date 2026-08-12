import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadWikiPromptGuidance } from "../dist/prompt-guidance.js";
import { promptFor, reviewContext, synthesisContext } from "../dist/prompts.js";
import { DEFAULT_WIKI_WORKFLOW_POLICY, resolveWikiPolicy } from "../dist/policy.js";

test("Chinese guidance prefers source-authored domain and concept names", async () => {
  const research = normalizeWhitespace(await loadWikiPromptGuidance("research", "zh"));
  assert.match(research, /Chinese name found in source code or comments/);
  assert.match(research, /Record source-authored domain and concept names or aliases/);

  const synthesis = normalizeWhitespace(await loadWikiPromptGuidance("synthesis", "zh"));
  assert.match(synthesis, /source-authored Chinese domain and concept names/);
  assert.match(synthesis, /Preserve source-authored Chinese domain and concept names/);

  const write = normalizeWhitespace(await loadWikiPromptGuidance("write", "zh", { pageTypes: ["concept"] }));
  assert.match(write, /preserve source-authored Chinese domain and concept names/);
  assert.match(write, /Do not silently replace them with your own translations/);

  const review = normalizeWhitespace(await loadWikiPromptGuidance("review", "zh"));
  assert.match(review, /invented translation that displaced an established Chinese name/);
});

test("research guidance requires structured findings and explicit gaps", async () => {
  const research = normalizeWhitespace(await loadWikiPromptGuidance("research", "en"));
  assert.match(research, /domain\|concept\|flow\|boundary\|state-data/);
  assert.match(research, /critical\|normal/);
  assert.match(research, /"summary": "Concise account/);
  assert.match(research, /engine derives a stable `findingId`/);
  assert.match(research, /wiki_submit_research/);
  assert.match(research, /bounded survey, then deepen/i);
  assert.match(research, /deepen before submit|deepen with targeted|survey and deepen/i);
  assert.match(research, /call `wiki_submit_research` with only the final summary and gaps/i);
  assert.match(research, /wiki_research_put_findings/);
  assert.match(research, /wiki_research_remove_finding/);
  assert.match(research, /wiki_research_findings/);
  assert.match(research, /within the budget stated at the end of the prompt/i);
  assert.doesNotMatch(research, /exact handoff path|with that path|wiki_write_handoff/i);
  assert.match(research, /Finding granularity/i);
  assert.match(research, /one public interface, module, end-to-end flow/i);
  assert.match(research, /Do not collapse an entire package/i);
  assert.match(research, /stop exploring/i);
  assert.match(research, /entry points/);
});

test("assembled prompts end with the configured submission protocol", async () => {
  const policy = resolveWikiPolicy({ quality: { maxSubmissionAttempts: 2 } });
  const prompt = await promptFor({
    id: "research-1",
    kind: "research",
    input: {
      batch: 0,
      scope: { id: "core", sourcePaths: ["src"], task: "Explain core behavior" },
      researchGroupId: "initial",
      priorResearchIds: [],
      continuationMode: "initial",
      dryAuditPasses: 0,
    },
  }, {
    language: "en",
    policy,
  }, undefined);
  assert.match(prompt, /## Required Completion Protocol/);
  assert.match(prompt, /call `wiki_submit_research` with only summary and gaps/i);
  assert.match(prompt, /one terminal submission tool accepts its required payload/i);
  assert.match(prompt, /Up to 2 submission attempts are available/);
  assert.match(prompt, /Do not finish with prose, a JSON code block, or a handoff file/);
  assert.match(prompt, /After acceptance, stop\.\s*$/);
});

test("synthesis guidance plans complete evidence-saturated coverage without page quotas", async () => {
  const synthesis = normalizeWhitespace(await loadWikiPromptGuidance("synthesis", "en"));
  assert.match(synthesis, /Every non-Overview domain must contain exactly one `domain` page/);
  assert.match(synthesis, /`<domain-id>\/domain\.md`/);
  assert.match(synthesis, /`readerQuestions`/);
  assert.match(synthesis, /`requiredFacets`/);
  assert.match(synthesis, /Critical findings cannot be omitted/);
  assert.match(synthesis, /Prefer `finalize` when no unresolved critical gaps remain/);
  assert.match(synthesis, /requiredDryCoverageAudits/);
  assert.match(synthesis, /There is no page quota/);
  assert.match(synthesis, /concurrency is scheduling only/);
  assert.match(synthesis, /Use only declared source paths and unused scope IDs/);
  assert.match(synthesis, /`concept`, `flow`, `state`, `data`, `module`, or `architecture`/);
  assert.match(synthesis, /ordering\/domain\.md/);
  assert.match(synthesis, /ordering\/states\/order-lifecycle\.md/);
  assert.match(synthesis, /wiki_submit_synthesis_expand/);
  assert.match(synthesis, /wiki_submit_synthesis_finalize/);
  assert.doesNotMatch(synthesis, /exact handoff path|wiki_write_handoff/i);
});

test("common guidance reserves indexes and trust metadata for finalization", async () => {
  const common = normalizeWhitespace(await loadWikiPromptGuidance("research", "en"));
  assert.match(common, /every directory `index.md` and the root `okf_version: "0.2"` declaration/);
  assert.match(common, /coordinator materializes indexes after each write or repair wave/);
  assert.match(common, /Never invent verification, human review, generation, or staleness metadata/);
});

test("all writer templates are packaged and independently selectable", async () => {
  const expected = new Map([
    ["overview", "Overview Page Skeleton"],
    ["domain", "Domain Page Skeleton"],
    ["architecture", "Architecture Page Skeleton"],
    ["module", "Module Page Skeleton"],
    ["flow", "Flow Page Skeleton"],
    ["concept", "Concept Page Skeleton"],
    ["state", "State Page Skeleton"],
    ["data", "Data Page Skeleton"],
  ]);
  for (const [pageType, heading] of expected) {
    const prompt = await loadWikiPromptGuidance("write", "en", { pageTypes: [pageType] });
    assert.match(prompt, new RegExp(heading));
  }
});

test("writer guidance enforces OKF v0.2 citations and same-session submission", async () => {
  const write = normalizeWhitespace(await loadWikiPromptGuidance("write", "en", { pageTypes: ["flow"] }));
  assert.match(write, /source is an object with a page-unique, stable `id`/);
  assert.match(write, /`resource` in the form `repo:<project>\/<path>#Lx-Ly`/);
  assert.match(write, /OKF source ID as `\[\^source-id\]`/);
  assert.match(write, /call `wiki_submit_page` for the assigned page/);
  assert.match(write, /Fix the complete result in the same writer session/);
  assert.match(write, /`flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, or `erDiagram`/);
  assert.match(write, /validator-infrastructure/);
  // Golden citation triple + anti-pattern anchors for writer remediation
  assert.match(write, /resource: repo:api\/src\/index\.ts#L1-L2/);
  assert.match(write, /\[\^api-index\]: \[Source\]\(repo:api\/src\/index\.ts#L1-L2\)/);
  assert.match(write, /Research evidence uses `project\/path#Lx-Ly`/);
  assert.match(write, /wiki citations use `repo:project\/path#Lx-Ly`/);
  assert.match(write, /Anti-patterns/);
  assert.match(write, /Direct repo in body/);
  assert.match(write, /Resource mismatch/);
});

test("review guidance emits one complete defect set for a repair wave", async () => {
  const review = normalizeWhitespace(await loadWikiPromptGuidance("review", "en"));
  assert.match(review, /complete actionable defect set across all pages in one result/);
  assert.match(review, /repairs affected pages together in one wave/);
  assert.match(review, /Do not repeat per-page format, citation, link, or Mermaid syntax validation/);
  assert.match(review, /passes its Write gate again/);
  assert.match(review, /Do not report syntax or validator infrastructure failures as semantic defects/);
  assert.match(review, /multiple independent reader questions/i);
  assert.match(review, /prefer `coverage` or `topology`/i);
  assert.match(review, /prefer `depth`/i);
  assert.match(review, /call `wiki_submit_review`\s+with only the summary/i);
  assert.match(review, /wiki_review_put_defects/);
  assert.match(review, /wiki_review_remove_defect/);
  assert.match(review, /terminal payload is exactly `\{"summary"/i);
  assert.doesNotMatch(review, /"defects"\s*:\s*\[/);
  assert.doesNotMatch(review, /exact handoff path|wiki_write_handoff/i);
});

test("review context separates domain responsibility from global fragment fan-in", () => {
  const spec = {
    domains: [{
      id: "core", title: "Core", purpose: "Core", pages: [{
        pageType: "domain", path: "core/domain.md", title: "Core", purpose: "Core",
        readerQuestions: ["How?"], requiredFacets: ["models"], findingIds: [],
      }],
    }],
    crossLinks: [], sharedTerms: [], omissions: [],
  };
  const run = {
    policy: resolveWikiPolicy(), focus: undefined,
    nodes: [{ id: "plan", kind: "synthesis", result: { decision: "finalize", spec, rationale: "ready" } }],
  };
  const domain = { kind: "review", input: {
    sourceNodeIds: [], synthesisNodeId: "plan", verificationGroupId: "v",
    reviewScope: { kind: "domain", domainId: "core", pagePaths: ["core/domain.md"] },
  } };
  const domainPrompt = reviewContext(domain, run);
  assert.match(domainPrompt, /Review only these pagePaths/);
  assert.match(domainPrompt, /"pagePaths": \[/);
  assert.doesNotMatch(domainPrompt, /Domain Review Fragments/);

  const global = { kind: "review", input: {
    sourceNodeIds: ["domain-review"], synthesisNodeId: "plan", verificationGroupId: "v",
    reviewScope: { kind: "global", domainReviewNodeIds: ["domain-review"] },
  } };
  const globalPrompt = reviewContext(global, run, { fragments: [{
    domainId: "core", pagePaths: ["core/domain.md"], summary: "Domain checked",
    defects: [{ kind: "depth", page: "core/domain.md", detail: "Missing invariant" }],
  }], omittedFragmentCount: 0 });
  assert.match(globalPrompt, /Domain Review Fragments/);
  assert.match(globalPrompt, /Domain checked/);
  assert.match(globalPrompt, /Missing invariant/);
  assert.match(globalPrompt, /cross-domain consistency, overview accuracy, coverage, and topology/);
  assert.match(globalPrompt, /do not repeat equivalent fragment defects/);
});

test("skill stays a concise workflow router to role references", async () => {
  const skill = await readFile(new URL("../skills/repository-wiki-producer/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /Structured research.*references\/research\.md/s);
  assert.match(skill, /Coverage planning and synthesis.*references\/synthesis\.md/s);
  assert.match(skill, /Per-page writing and repair.*references\/write\.md/s);
  assert.match(skill, /Global semantic review.*references\/review\.md/s);
  assert.ok(skill.split("\n").length < 80, "SKILL.md should remain a concise router");
});

test("synthesis round JSON injects remaining budgets and prefer-finalize policy", () => {
  const node = {
    id: "synthesis-1",
    kind: "synthesis",
    input: {
      researchIds: [],
      supplementalBatch: 0,
      mode: "initial",
      dryAuditPasses: 0,
      round: 1,
    },
  };
  const run = {
    effectiveMode: "generate",
    requestedMode: "generate",
    focus: undefined,
    maxResearchRounds: DEFAULT_WIKI_WORKFLOW_POLICY.research.maxResearchRounds,
    policy: resolveWikiPolicy(),
    inspection: { sourcePaths: ["src-core"] },
    nodes: [],
  };
  const context = synthesisContext(node, run, []);
  assert.match(context, /"requiredDryCoverageAudits": 1/);
  assert.match(context, /"preferFinalizeWhenNoCriticalGaps": true/);
  assert.match(context, /"remainingExpandRounds":/);
  assert.match(context, /"remainingAuditRounds":/);
  assert.match(context, /"maxExpandScopesPerBatch": 4/);
});

test("structural replanning uses the preseeded plan without embedding the full prior spec", () => {
  const spec = {
    domains: [{
      id: "overview", title: "Overview", purpose: "secret-purpose-that-must-not-be-inlined",
      pages: [{ pageType: "overview", path: "overview/overview.md", title: "Overview", purpose: "secret-page-purpose", readerQuestions: ["Secret question?"], requiredFacets: ["domain map"], findingIds: [] }],
    }],
    crossLinks: [], sharedTerms: [], omissions: [],
  };
  const node = { id: "structural", kind: "synthesis", input: { researchIds: [], supplementalBatch: 0, mode: "structural", dryAuditPasses: 1, round: 2, priorSynthesisNodeId: "prior", trigger: { issues: [] } } };
  const run = {
    effectiveMode: "generate", requestedMode: "generate", maxResearchRounds: 3,
    policy: resolveWikiPolicy(), inspection: { sourcePaths: ["src"] },
    nodes: [{ id: "prior", kind: "synthesis", result: { decision: "finalize", spec } }],
  };
  const context = synthesisContext(node, run, []);
  assert.match(context, /Preseeded Prior WikiSpec/);
  assert.match(context, /wiki_spec_get_domain/);
  assert.match(context, /"pageCount": 1/);
  assert.doesNotMatch(context, /secret-purpose|secret-page-purpose|Secret question/);
});

function normalizeWhitespace(value) {
  return value.replaceAll(/\s+/g, " ");
}
