import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadWikiPromptGuidance } from "../dist/prompt-guidance.js";
import { synthesisContext } from "../dist/prompts.js";
import { DEFAULT_WIKI_WORKFLOW_POLICY } from "../dist/policy.js";

test("Chinese guidance prefers source-authored domain and concept names", async () => {
  const research = normalizeWhitespace(await loadWikiPromptGuidance("research", "zh"));
  assert.match(research, /Chinese name found in source code or comments/);
  assert.match(research, /Record source-authored domain and concept names or aliases/);

  const synthesis = normalizeWhitespace(await loadWikiPromptGuidance("synthesis", "zh"));
  assert.match(synthesis, /source-authored Chinese domain and concept names/);
  assert.match(synthesis, /take precedence over translated English names/);

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
  assert.match(research, /submit a complete handoff|call `wiki_submit_research` with that path \*\*once\*\*/i);
  assert.match(research, /Do not call `wiki_submit_research` more than once/i);
  assert.match(research, /Finding granularity/i);
  assert.match(research, /one public interface, module, end-to-end flow/i);
  assert.match(research, /Do not collapse an entire package/i);
  assert.match(research, /stop exploring/i);
  assert.match(research, /entry points/);
});

test("synthesis guidance plans complete evidence-saturated coverage without page quotas", async () => {
  const synthesis = normalizeWhitespace(await loadWikiPromptGuidance("synthesis", "en"));
  assert.match(synthesis, /Every content page selects one or more exact `findingId` values/);
  assert.match(synthesis, /`omissions` as `\{ "findingId": "\.\.\.", "rationale": "\.\.\." \}`/);
  assert.match(synthesis, /A critical finding cannot be omitted/);
  assert.match(synthesis, /Prefer finalize when research receipts report no unresolved critical gaps/);
  assert.match(synthesis, /requiredDryCoverageAudits/);
  assert.match(synthesis, /There is no per-repository page limit/);
  assert.match(synthesis, /concurrency is scheduling only/);
  assert.match(synthesis, /scheduling limit must never reduce the number of scopes/);
  assert.match(synthesis, /Entity cluster heuristic/i);
  assert.match(synthesis, /modules\/|`modules\//);
  assert.match(synthesis, /flows\/|concepts\//);
  assert.match(synthesis, /flows\/auth\/login-handoff\.md/);
  assert.match(synthesis, /"crossLinks"/);
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
    ["architecture", "Architecture Page Skeleton"],
    ["module", "Module Page Skeleton"],
    ["flow", "Flow Page Skeleton"],
    ["concept", "Concept Page Skeleton"],
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
  assert.match(review, /rerunning the complete Verify stage/);
  assert.match(review, /Do not report syntax or validator infrastructure failures as semantic defects/);
  assert.match(review, /multiple independent reader questions/i);
  assert.match(review, /prefer `coverage` or `topology`/i);
  assert.match(review, /prefer `depth`/i);
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

function normalizeWhitespace(value) {
  return value.replaceAll(/\s+/g, " ");
}
