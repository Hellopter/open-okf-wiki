import assert from "node:assert/strict";
import test from "node:test";
import { WikiRejectedError } from "../dist/wiki-reject.js";
import { ingestEvidenceHandoff, inspectEvidenceHandoff } from "../dist/evidence-ledger.js";
import { createWikiDelegateContract } from "../dist/delegate-contracts.js";

const ref = (kind) => ({
  version: 1, runId: "run-1", nodeId: "b1-task", attempt: 1, scope: ["source"], kind,
  relativePath: `.okf-wiki/blobs/${"a".repeat(64)}.md`, sha256: "a".repeat(64), sizeBytes: 1, mediaType: "text/markdown",
});

test("EvidenceLedger indexes role-specific research Markdown without retaining prose", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: ["runtime"], lensScopeIds: ["api"], resolvesIds: [],
  });
  const markdown = [
    "# Research Handoff", "## Scope", "assignment:assignment-1",
    "## Coverage", "assignment:assignment-1", "## Conflicts and alternatives", "None", "## Gaps and failed reads", "None", "## Evidence", "repo:source/src/runtime.ts#L10-L20",
  ].join("\n");
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.assignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "src/runtime.ts", startLine: 10, endLine: 20 }]);
  assert.equal(Object.hasOwn(entry, "markdown"), false);
});

test("EvidenceLedger accepts host completion coverage when Markdown omits assignment tokens", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = "# Research Handoff\n## Scope\nCovered the assigned source scope.\n## Coverage\nVerified entry points.\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:source/file.ts#L1-L2";
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.completedAssignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.assignmentIds, []);
});

test("EvidenceLedger indexes a handoff after valid leading YAML frontmatter", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = "---\nfollowups: []\n---\n# Research Handoff\n## Scope\nassignment:assignment-1\n## Coverage\nComplete\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:source/file.ts#L1-L2";
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.assignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "file.ts", startLine: 1, endLine: 2 }]);
});

test("EvidenceLedger rejects wrong handoff kind, undeclared assignments, and unqualified citations", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = "# Research Handoff\n## Scope\nassignment:assignment-1\n## Coverage\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:source/file.ts#L1-L2";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("write-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] }), /kind/);
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: markdown.replaceAll("assignment-1", "other"), contract, completedAssignmentIds: ["other"] }), /undeclared/);
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: markdown.replace("repo:source/file.ts#L1-L2", "repo:source/file.ts#L1"), contract, completedAssignmentIds: ["assignment-1"] }), /citation/);
});

test("EvidenceLedger citations cannot use artifact, domain, lens, or context scopes", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: ["artifact-ref"],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: ["runtime"], lensScopeIds: ["api"], resolvesIds: [],
  });
  const markdown = "# Research Handoff\n## Scope\nassignment:assignment-1\n## Coverage\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:runtime/file.ts#L1-L2";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] }), /citation scopes outside pinned scopes: runtime \(allowed: source\)/);
});

test("EvidenceLedger requires the documented conflict and failed-read sections", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const base = "# Research Handoff\n## Scope\nassignment:assignment-1\n## Coverage\n";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: `${base}## Evidence\nrepo:source/file.ts#L1-L2`, contract, completedAssignmentIds: ["assignment-1"] }), /missing headings: Conflicts and alternatives, Gaps and failed reads/);
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: `${base}## Conflicts and alternatives\nNone\n## Evidence\nrepo:source/file.ts#L1-L2`, contract, completedAssignmentIds: ["assignment-1"] }), /missing headings: Gaps and failed reads/);
});

test("EvidenceLedger accepts the Skill-format research handoff with Scope", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = [
    "---", "followups: []", "---",
    "# Research Handoff",
    "## Scope", "- **Source:** source",
    "## Coverage", "The runtime maps each request to a pinned Source.",
    "## Evidence", "repo:source/file.ts#L1-L2",
    "## Conflicts and alternatives", "None",
    "## Gaps and failed reads", "None",
  ].join("\n");
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "file.ts", startLine: 1, endLine: 2 }]);
  assert.deepEqual(entry.indexes.assignmentIds, []);
});

test("EvidenceLedger rejects the retired Assignments heading as a substitute for Scope", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = "# Research Handoff\n## Assignments\nCovered the assigned source scope.\n## Coverage\nVerified entry points.\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:source/file.ts#L1-L2";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] }), /missing headings: Scope/);
});

test("EvidenceLedger collects headings, citations, scopes, and assignment IDs together", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source-a", "source-b"], contextRefs: [],
    mode: "discovery", assignmentIds: ["a1", "a2"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = [
    "Covered without a role heading.",
    "## Coverage",
    "assignment:a3",
    "## Evidence",
    "source/a.ts#L1-L1",
    "repo:foo/file.ts#L1-L2",
    "repo:source-a/file.ts#L9-L2",
  ].join("\n");
  const inspected = inspectEvidenceHandoff({ markdown, contract });
  assert.ok(inspected.defects.includes("missing level-one role heading"));
  assert.match(inspected.defects.join("; "), /missing headings: Research Handoff, Scope, Conflicts and alternatives, Gaps and failed reads/);
  assert.match(inspected.defects.join("; "), /invalid citations: source\/a\.ts#L1-L1 need repo:scope\/path#Lx-Ly/);
  assert.match(inspected.defects.join("; "), /repo:source-a\/file\.ts#L9-L2 end<start/);
  assert.match(inspected.defects.join("; "), /citation scopes outside pinned scopes: foo \(allowed: source-a, source-b\)/);
  assert.match(inspected.defects.join("; "), /undeclared assignment IDs: a3 \(declared: a1, a2\)/);
  assert.equal(inspected.indexes, undefined);
  assert.throws(
    () => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["a1"] }),
    (error) => {
      assert.ok(error instanceof WikiRejectedError);
      assert.match(error.message, /missing headings: Research Handoff, Scope/);
      assert.match(error.message, /allowed: source-a, source-b/);
      assert.match(error.message, /declared: a1, a2/);
      return true;
    },
  );
});

test("EvidenceLedger names why a citation is invalid without repeating the file body", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = [
    "# Research Handoff", "## Scope", "ok", "## Coverage", "ok",
    "## Conflicts and alternatives", "None", "## Gaps and failed reads", "None",
    "## Evidence",
    "source/a.ts#L1-L1",
    "repo:source/missing.ts#L1-L1",
    "repo:source/a.ts#L9-L12",
    "repo:source/a.ts#L1-L1",
  ].join("\n");
  const inspected = inspectEvidenceHandoff({
    markdown,
    contract,
    fileLines: (citation) => citation.path === "a.ts" ? 2 : "missing",
  });
  const defects = inspected.defects.join("; ");
  assert.match(defects, /source\/a\.ts#L1-L1 need repo:scope\/path#Lx-Ly/);
  assert.match(defects, /repo:source\/missing\.ts#L1-L1 missing/);
  assert.match(defects, /repo:source\/a\.ts#L9-L12 a\.ts:2 lines/);
  assert.doesNotMatch(defects, /export const|function |# Research Handoff/);
});

test("EvidenceLedger accepts the Skill-format write completion handoff", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "write", instruction: "Write", sourceScopeIds: ["source"], contextRefs: [],
    writePaths: ["wiki/source/core/domain.md"],
  });
  const markdown = "# Write Handoff\n\nUpdated the assigned page.\n";
  const entry = ingestEvidenceHandoff({ artifact: ref("write-handoff"), markdown, contract });
  assert.deepEqual(entry.indexes.pageIds, []);
  assert.deepEqual(entry.indexes.citations, []);
});

test("EvidenceLedger accepts the Skill-format review handoff", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "review", instruction: "Review", sourceScopeIds: ["source"], contextRefs: [],
    reviewPaths: ["wiki/source/core/domain.md"],
  }, {
    version: 1, candidateRevision: 1, treeDigest: "a".repeat(64), policyDigest: "b".repeat(64),
    paths: ["wiki/source/core/domain.md"],
  });
  const markdown = [
    "---",
    "findings:",
    "  - path: wiki/source/core/domain.md",
    "    severity: major",
    "profileCoverage:",
    "  - evidence-fidelity",
    "---",
    "# Review Handoff",
    "## Findings", "The page needs one evidence correction.",
    "## Evidence", "repo:source/file.ts#L1-L2",
  ].join("\n");
  const entry = ingestEvidenceHandoff({ artifact: ref("review-handoff"), markdown, contract });
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "file.ts", startLine: 1, endLine: 2 }]);
});
