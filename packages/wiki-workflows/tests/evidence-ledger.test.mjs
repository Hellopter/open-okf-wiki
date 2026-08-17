import assert from "node:assert/strict";
import test from "node:test";
import { ingestEvidenceHandoff } from "../dist/evidence-ledger.js";
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
    "# Research Handoff", "## Assignments", "assignment:assignment-1",
    "## Coverage", "assignment:assignment-1", "## Conflicts and alternatives", "None", "## Gaps and failed reads", "None", "## Evidence", "repo:source/src/runtime.ts#L10-L20",
  ].join("\n");
  const entry = ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] });
  assert.deepEqual(entry.indexes.assignmentIds, ["assignment-1"]);
  assert.deepEqual(entry.indexes.citations, [{ scope: "source", path: "src/runtime.ts", startLine: 10, endLine: 20 }]);
  assert.equal(Object.hasOwn(entry, "markdown"), false);
});

test("EvidenceLedger rejects wrong handoff kind, undeclared assignments, and unqualified citations", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const markdown = "# Research Handoff\n## Assignments\nassignment:assignment-1\n## Coverage\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:source/file.ts#L1-L2";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("write-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] }), /kind/);
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: markdown.replaceAll("assignment-1", "other"), contract, completedAssignmentIds: ["other"] }), /undeclared/);
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: markdown.replace("repo:source/file.ts#L1-L2", "repo:source/file.ts#L1"), contract, completedAssignmentIds: ["assignment-1"] }), /citation/);
});

test("EvidenceLedger citations cannot use artifact, domain, lens, or context scopes", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: ["artifact-ref"],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: ["runtime"], lensScopeIds: ["api"], resolvesIds: [],
  });
  const markdown = "# Research Handoff\n## Assignments\nassignment:assignment-1\n## Coverage\n## Conflicts and alternatives\nNone\n## Gaps and failed reads\nNone\n## Evidence\nrepo:runtime/file.ts#L1-L2";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown, contract, completedAssignmentIds: ["assignment-1"] }), /pinned source scope/);
});

test("EvidenceLedger requires the documented conflict and failed-read sections", () => {
  const contract = createWikiDelegateContract(1, {
    id: "task", role: "research", instruction: "Survey", sourceScopeIds: ["source"], contextRefs: [],
    mode: "discovery", assignmentIds: ["assignment-1"], domainScopeIds: [], lensScopeIds: [], resolvesIds: [],
  });
  const base = "# Research Handoff\n## Assignments\nassignment:assignment-1\n## Coverage\n";
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: `${base}## Evidence\nrepo:source/file.ts#L1-L2`, contract, completedAssignmentIds: ["assignment-1"] }), /conflicts and alternatives/);
  assert.throws(() => ingestEvidenceHandoff({ artifact: ref("research-handoff"), markdown: `${base}## Conflicts and alternatives\nNone\n## Evidence\nrepo:source/file.ts#L1-L2`, contract, completedAssignmentIds: ["assignment-1"] }), /gaps and failed reads/);
});
