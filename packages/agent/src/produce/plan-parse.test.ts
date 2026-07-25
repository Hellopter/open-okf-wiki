import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { PLAN_DRAFT_REL_PATH, planDraftPathFromRunWorkDir, writePlanDraft } from "./living-spec.js";
import { parsePlanFromAgentText, resolvePlanSpecFromAgentResult } from "./plan.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

function largeSpec(name: string) {
  const base = defaultWikiRunSpec(name);
  return {
    ...base,
    summary: `Source-grounded wiki for ${name} — ${"detail ".repeat(40)}`.slice(0, 500),
    domains: Array.from({ length: 6 }, (_, i) => ({
      id: `d${i}`,
      title: `Domain ${i}`,
      scope: `scope area ${i} ${"x".repeat(80)}`,
      critical: true,
      questions: Array.from({ length: 4 }, (_, q) => `Question ${q} for domain ${i}`),
    })),
    pages: Array.from({ length: 10 }, (_, i) => ({
      path: i === 0 ? "overview.md" : `page-${i}.md`,
      purpose: `purpose ${i} ${"y".repeat(40)}`,
      domainIds: [`d${i % 6}`],
      questions: ["What is covered?", "Where is the entry point?"],
      template: i === 0 ? ("overview" as const) : ("module" as const),
      critical: i === 0,
    })),
    openQuestions: ["o1", "o2", "o3"],
    acceptance: {
      reviewRequired: true,
      maxRepairRounds: 2,
      blockingSeverities: ["blocking" as const],
    },
    changelog: ["planned"],
  };
}

test("parsePlanFromAgentText accepts a complete fenced WikiRunSpec", () => {
  const expected = defaultWikiRunSpec("Demo");
  const plan = parsePlanFromAgentText(
    ["Here is the plan:", "```json", JSON.stringify(expected), "```"].join("\n"),
  );
  assert.deepEqual(plan, expected);
});

test("parsePlanFromAgentText accepts a complete raw WikiRunSpec", () => {
  const expected = defaultWikiRunSpec("Raw");
  assert.deepEqual(parsePlanFromAgentText(JSON.stringify(expected)), expected);
});

test("parsePlanFromAgentText accepts a large complete Spec (>4k)", () => {
  const expected = largeSpec("Big");
  const text = ["narration…", "```json", JSON.stringify(expected, null, 2), "```"].join("\n");
  assert.ok(text.length > 4000, `fixture should exceed 4k (got ${text.length})`);
  const plan = parsePlanFromAgentText(text);
  assert.equal(plan.pages.length, 10);
  assert.equal(plan.domains.length, 6);
});

test("parsePlanFromAgentText rejects head-truncated large Spec (historical control bug)", () => {
  const expected = largeSpec("Trunc");
  const full = ["```json", JSON.stringify(expected, null, 2), "```"].join("\n");
  const truncated = `${full.slice(0, 3999)}…`;
  assert.throws(() => parsePlanFromAgentText(truncated), /complete JSON WikiRunSpec/);
});

test("parsePlanFromAgentText prefers the last fenced JSON block", () => {
  const expected = defaultWikiRunSpec("LastFence");
  const text = [
    "```json",
    JSON.stringify({ summary: "thin", pages: [{ path: "x.md", purpose: "x" }] }),
    "```",
    "Final plan:",
    "```json",
    JSON.stringify(expected),
    "```",
  ].join("\n");
  assert.deepEqual(parsePlanFromAgentText(text), expected);
});

test("parsePlanFromAgentText rejects Markdown page-list compatibility", () => {
  assert.throws(
    () =>
      parsePlanFromAgentText(
        ["### Pages", "- `overview.md` — Project purpose and navigation"].join("\n"),
      ),
    /complete JSON WikiRunSpec/,
  );
});

test("parsePlanFromAgentText rejects a thin legacy JSON plan", () => {
  assert.throws(
    () =>
      parsePlanFromAgentText(
        `\`\`\`json\n${JSON.stringify({ summary: "Thin", pages: [{ path: "x.md", purpose: "x" }] })}\n\`\`\``,
      ),
    /complete JSON WikiRunSpec/,
  );
});

test("resolvePlanSpecFromAgentResult prefers on-disk plan-draft", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "okf-plan-draft-"));
  temps.push(dir);
  const expected = defaultWikiRunSpec("FromDisk");
  await writePlanDraft(dir, expected);
  const resolved = await resolvePlanSpecFromAgentResult({
    runWorkDir: dir,
    summary: "garbage that is not a Spec",
  });
  assert.equal(resolved.source, "draft");
  assert.equal(resolved.spec.summary, expected.summary);
  assert.equal(resolved.draftPath, planDraftPathFromRunWorkDir(dir));
});

test("resolvePlanSpecFromAgentResult spills text parse into plan-draft", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "okf-plan-spill-"));
  temps.push(dir);
  const expected = largeSpec("Spill");
  const text = JSON.stringify(expected);
  assert.ok(text.length > 4000);
  const resolved = await resolvePlanSpecFromAgentResult({
    runWorkDir: dir,
    summary: text,
  });
  assert.equal(resolved.source, "text");
  assert.equal(resolved.spec.pages.length, 10);
  const raw = await readFile(planDraftPathFromRunWorkDir(dir), "utf8");
  assert.match(raw, /overview\.md/);
  assert.match(PLAN_DRAFT_REL_PATH, /plan-draft\.json/);
});
