import assert from "node:assert/strict";
import test from "node:test";

test("phaseTitleForKind / phaseIdForKind / phaseMetaForKind map node kinds onto dashboard stages", async () => {
  const {
    WIKI_WORKFLOW_PHASES,
    WIKI_WORKFLOW_STAGES,
    phaseIdForKind,
    phaseMetaForKind,
    phaseRefForKind,
    phaseTitleForKind,
  } = await import("../dist/workflow-phases.js");
  const { phaseTitleFor } = await import("../dist/run-graph.js");
  const { stageLabel } = await import("../dist/ui/format.js");

  assert.deepEqual(
    WIKI_WORKFLOW_PHASES.map((phase) => phase.id),
    ["inspect", "research", "plan", "write", "review"],
  );
  assert.equal(WIKI_WORKFLOW_STAGES, WIKI_WORKFLOW_PHASES);

  const cases = [
    ["inspect", "inspect", "Inspect"],
    ["research", "research", "Research"],
    ["synthesis", "plan", "Plan"],
    ["write", "write", "Write"],
    ["validate", "write", "Write"],
    ["review", "review", "Review & Publish"],
    ["finalize", "review", "Review & Publish"],
  ];

  for (const [kind, id, title] of cases) {
    assert.equal(phaseIdForKind(kind), id, kind);
    assert.equal(phaseTitleForKind(kind), title, kind);
    assert.deepEqual(phaseMetaForKind(kind), { id, title }, kind);
    assert.deepEqual(phaseRefForKind(kind), { id, title }, `phaseRef alias ${kind}`);
    assert.equal(phaseTitleFor(kind), title, `run-graph ${kind}`);
    assert.equal(stageLabel(kind), title, `stageLabel ${kind}`);
  }
});
