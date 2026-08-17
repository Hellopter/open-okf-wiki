import assert from "node:assert/strict";
import test from "node:test";
import { truncateUtf8 } from "../dist/delegate-contracts.js";
import {
  MAX_WIKI_WORK_FILE_BYTES,
  decodeUtf8Fatal,
  parseResearchHandoff,
  parseReviewHandoff,
  summarizeWikiMarkdown,
} from "../dist/wiki-work-files.js";

const research = (frontmatter, body = "Summary paragraph.\n\nDetailed evidence.") =>
  `---\n${frontmatter}\n---\n${body}\n`;

test("truncateUtf8 respects ASCII, Han, emoji, and combining code point boundaries", () => {
  assert.equal(truncateUtf8("abcd", 3), "abc");
  assert.equal(truncateUtf8("中文", 5), "中");
  assert.equal(truncateUtf8("A😀B", 5), "A😀");
  assert.equal(truncateUtf8("e\u0301x", 2), "e");
  assert.equal(Buffer.byteLength(truncateUtf8("中😀e\u0301", 8), "utf8") <= 8, true);
  assert.throws(() => truncateUtf8("x", -1), /non-negative safe integer/);
});

test("decodeUtf8Fatal decodes valid bytes and rejects malformed UTF-8", () => {
  assert.equal(decodeUtf8Fatal(Buffer.from("中文😀", "utf8")), "中文😀");
  assert.throws(() => decodeUtf8Fatal(Uint8Array.from([0xc3, 0x28])), /Malformed UTF-8/);
});

test("parseResearchHandoff derives a byte-bounded summary and injects Source scopes", () => {
  const longSummary = "😀".repeat(300);
  const result = parseResearchHandoff(research([
    "followups:",
    "  - kind: evidence_gap",
    "    question: Verify the fallback path",
  ].join("\n"), `${longSummary}\n\nMore detail.`), "complete", ["source-a", "source-b"]);
  assert.equal(Buffer.byteLength(result.summary, "utf8"), 1024);
  assert.equal(result.summary, "😀".repeat(256));
  assert.deepEqual(result, {
    status: "complete",
    summary: "😀".repeat(256),
    needsFollowup: true,
    followups: [{
      kind: "evidence_gap",
      question: "Verify the fallback path",
      sourceScopeIds: ["source-a", "source-b"],
    }],
  });
});

test("parseResearchHandoff derives its summary from Skill-format substantive prose", () => {
  const body = [
    "",
    "# Research Handoff",
    "",
    "## Scope",
    "",
    "- **Source:** source",
    "",
    "## Coverage",
    "",
    "The runtime maps each request to a pinned Source",
    "and preserves conflicts for later synthesis.",
    "",
    "## Evidence",
    "",
    "- repo:source/runtime.ts#L1-L10",
  ].join("\n");
  const result = parseResearchHandoff(research("followups: []", body), "complete", ["source"]);
  assert.equal(result.summary, "The runtime maps each request to a pinned Source and preserves conflicts for later synthesis.");
});

test("completion summary skips Markdown structure and remains UTF-8 bounded", () => {
  const prose = `Published current reviewed coverage ${"😀".repeat(300)}`;
  const summary = summarizeWikiMarkdown([
    "# Completion",
    "",
    "- **Status:** complete",
    "",
    prose,
  ].join("\n"), "completion.md");
  assert.equal(summary, truncateUtf8(prose, 1024));
  assert.equal(Buffer.byteLength(summary, "utf8"), 1024);
});

test("parseResearchHandoff accepts every followup kind", () => {
  const kinds = ["unread_scope", "evidence_gap", "conflict", "taxonomy_uncertain", "tool_failure"];
  const yaml = ["followups:", ...kinds.flatMap((kind) => [
    `  - kind: ${kind}`,
    `    question: Question for ${kind}`,
  ])].join("\n");
  const result = parseResearchHandoff(research(yaml), "incomplete", ["source"]);
  assert.deepEqual(result.followups.map((followup) => followup.kind), kinds);
});

test("parseResearchHandoff preserves an empty allowed Source scope set", () => {
  const result = parseResearchHandoff(research([
    "followups:",
    "  - kind: tool_failure",
    "    question: Artifact read failed",
  ].join("\n")), "incomplete", []);
  assert.deepEqual(result.followups[0].sourceScopeIds, []);
});

test("parseResearchHandoff truncates oversized followup questions to 512 UTF-8 bytes", () => {
  const oversized = "中".repeat(171);
  const result = parseResearchHandoff(research([
    "followups:",
    "  - kind: evidence_gap",
    `    question: ${oversized}`,
  ].join("\n")), "incomplete", ["source"]);
  assert.equal(result.followups[0].question, truncateUtf8(oversized, 512));
  assert.ok(Buffer.byteLength(result.followups[0].question, "utf8") <= 512);
  assert.equal(result.followups[0].question, "中".repeat(170));
});

test("parseResearchHandoff rejects unknown YAML keys with file fields", () => {
  assert.throws(() => parseResearchHandoff(research("followups: []\nsummary: forged"), "complete", ["source"]), /handoff\.md frontmatter has unknown field: summary/);
  assert.throws(() => parseResearchHandoff(research("followups:\n  - kind: evidence_gap\n    question: gap\n    source: forged"), "incomplete", ["source"]), /handoff\.md frontmatter\.followups\[0\] has unknown field: source/);
});

test("handoff parsers reject empty bodies, malformed bytes, and files over 256 KiB", () => {
  assert.throws(() => parseResearchHandoff(research("followups: []", "   "), "complete", ["source"]), /handoff\.md body must be nonempty/);
  const malformed = Buffer.concat([Buffer.from("---\nfollowups: []\n---\nbody\n"), Buffer.from([0xc3, 0x28])]);
  assert.throws(() => parseResearchHandoff(malformed, "complete", ["source"]), /Malformed UTF-8/);
  assert.throws(() => parseResearchHandoff("x".repeat(MAX_WIKI_WORK_FILE_BYTES + 1), "complete", ["source"]), /handoff\.md exceeds 256 KiB/);
});

test("parseReviewHandoff validates assignments and host-mints deterministic finding IDs", () => {
  const markdown = research([
    "findings:",
    "  - path: wiki/a.md",
    "    severity: major",
    "  - path: wiki/b.md",
    "    severity: minor",
    "profileCoverage:",
    "  - evidence-fidelity",
  ].join("\n"), "Review complete.\n\nFinding details.");
  const first = parseReviewHandoff(markdown, "changes_requested", ["wiki/a.md", "wiki/b.md"]);
  const second = parseReviewHandoff(markdown, "changes_requested", ["wiki/a.md", "wiki/b.md"]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    verdict: "changes_requested",
    reviewedPaths: ["wiki/a.md", "wiki/b.md"],
    findings: [
      { id: "finding-1", path: "wiki/a.md", severity: "major" },
      { id: "finding-2", path: "wiki/b.md", severity: "minor" },
    ],
    profileCoverage: ["evidence-fidelity"],
  });
});

test("parseReviewHandoff rejects unknown fields and findings outside assigned paths", () => {
  assert.throws(() => parseReviewHandoff(research([
    "findings:",
    "  - path: wiki/outside.md",
    "    severity: critical",
    "profileCoverage: []",
  ].join("\n")), "changes_requested", ["wiki/a.md"]), /review\.md frontmatter\.findings\[0\]\.path is outside assigned paths/);
  assert.throws(() => parseReviewHandoff(research([
    "findings: []",
    "profileCoverage: []",
    "reviewedPaths: []",
  ].join("\n")), "pass", ["wiki/a.md"]), /review\.md frontmatter has unknown field: reviewedPaths/);
});
