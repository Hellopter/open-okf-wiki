import assert from "node:assert/strict";
import test from "node:test";
import { projectWikiBoard, renderWikiBoard } from "../dist/wiki-board.js";
import { parseWikiSpec } from "../dist/wiki-spec.js";

function sampleModel() {
  return {
    runId: "run-abc",
    specRevision: 2,
    candidateRevision: 4,
    compactionObserved: true,
    directWriteAllowed: false,
    delegatedTaskCount: 3,
    delegateBatchCount: 2,
    clusters: [
      {
        id: "core",
        paths: ["overview.md"],
        status: "accepted",
        terminalWriteOrReviewCount: 0,
      },
      {
        id: "core/runtime",
        paths: ["core/runtime/concept.md", "core/runtime/module.md"],
        status: "writing",
        terminalWriteOrReviewCount: 1,
      },
    ],
    tasks: [
      {
        id: "research-1",
        role: "research",
        paths: ["core/runtime/concept.md"],
        phase: "terminal",
        receiptStatus: "complete",
      },
      {
        id: "review-3",
        role: "review",
        paths: ["overview.md"],
        phase: "terminal",
        receiptStatus: "failed",
        errorCode: "review_timeout",
      },
      {
        id: "write-2",
        role: "write",
        paths: ["core/runtime/concept.md"],
        phase: "running",
      },
    ],
    remaining: [
      "write core/runtime/module.md",
      "review core/runtime/concept.md",
    ],
  };
}

const expectedBoard = `\
# Wiki board

- run: run-abc
- specRevision: 2
- candidateRevision: 4
- compactionObserved: yes
- directWriteAllowed: no
- delegatedTasks: 3
- delegateBatches: 2

## Clusters

- \`core\` **accepted** (writes/reviews: 0)
  - overview.md
- \`core/runtime\` **writing** (writes/reviews: 1)
  - core/runtime/concept.md
  - core/runtime/module.md

## Tasks

- \`research-1\` research terminal complete
- \`review-3\` review terminal failed review_timeout
- \`write-2\` write running

## Remaining

- write core/runtime/module.md
- review core/runtime/concept.md
`;

test("renders a known-good board model as stable Markdown", () => {
  assert.equal(renderWikiBoard(sampleModel()), expectedBoard);
});

test("empty remaining renders - none", () => {
  const model = sampleModel();
  model.remaining = [];
  const rendered = renderWikiBoard(model);
  assert.match(rendered, /^## Remaining\n\n- none\n$/m);
  assert.equal(rendered.includes("- write core/runtime/module.md"), false);
});

test("blocked cluster shows blocked when terminalWriteOrReviewCount is at least 3", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
    spec: projectionSpec(),
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "terminal", writePaths: ["wiki/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "w2", role: "write", phase: "terminal", writePaths: ["wiki/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "r1", role: "review", phase: "terminal", reviewPaths: ["wiki/core/runtime/concept.md"], receipt: { status: "complete" } },
        ],
      }],
    },
  });
  const runtime = model.clusters.find((cluster) => cluster.id === "core/runtime");
  assert.equal(runtime.status, "blocked");
  assert.equal(runtime.terminalWriteOrReviewCount, 3);
  assert.match(renderWikiBoard(model), /`core\/runtime` \*\*blocked\*\* \(writes\/reviews: 3\)/);
  assert.match(renderWikiBoard(model), /`_root` \*\*unplanned\*\*/);
});

test("renderWikiBoard prints projected status without overriding accepted to blocked", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 1,
    compactionObserved: false,
    spec: projectionSpec(),
    reviews: [
      { verdict: "pass", reviewedPaths: ["wiki/core/domain.md"] },
    ],
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "terminal", writePaths: ["wiki/core/domain.md"], receipt: { status: "complete" } },
          { id: "w2", role: "write", phase: "terminal", writePaths: ["wiki/core/domain.md"], receipt: { status: "complete" } },
          { id: "r1", role: "review", phase: "terminal", reviewPaths: ["wiki/core/domain.md"], receipt: { status: "complete" } },
        ],
      }],
    },
  });
  const core = model.clusters.find((cluster) => cluster.id === "core");
  assert.equal(core.status, "accepted");
  assert.equal(core.terminalWriteOrReviewCount, 3);
  assert.match(renderWikiBoard(model), /`core` \*\*accepted\*\* \(writes\/reviews: 3\)/);
});

function page(pageType, pagePath) {
  return { pageType, path: pagePath, title: pagePath, purpose: "Document", readerQuestions: ["Why?"], requiredFacets: [], findingIds: [] };
}

function projectionSpec() {
  return parseWikiSpec({
    version: 1,
    overview: page("overview", "overview.md"),
    domains: [{
      id: "core",
      title: "Core",
      purpose: "Core",
      pages: [page("domain", "core/domain.md"), page("concept", "core/runtime/concept.md")],
    }],
    crossLinks: [],
    sharedTerms: [],
    omissions: [],
  });
}

test("projector maps a DTO to accepted, blocked, and remaining cluster work", () => {
  const model = projectWikiBoard({
    runId: "run-1",
    specRevision: 1,
    candidateRevision: 4,
    compactionObserved: false,
    spec: projectionSpec(),
    reviews: [
      { verdict: "pass", reviewedPaths: ["wiki/core/domain.md"] },
      { verdict: "changes_requested", reviewedPaths: ["wiki/core/runtime/concept.md"] },
    ],
    delegates: {
      batches: [{
        tasks: [
          { id: "w1", role: "write", phase: "terminal", writePaths: ["wiki/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "w2", role: "write", phase: "terminal", writePaths: ["wiki/core/runtime/concept.md"], receipt: { status: "complete" } },
          { id: "r1", role: "review", phase: "terminal", reviewPaths: ["wiki/core/runtime/concept.md"], receipt: { status: "complete" } },
        ],
      }],
    },
  });
  const byId = Object.fromEntries(model.clusters.map((cluster) => [cluster.id, cluster]));
  assert.equal(byId._root.status, "unplanned");
  assert.deepEqual(byId._root.paths, ["overview.md"]);
  assert.equal(byId.core.status, "accepted");
  assert.equal(byId["core/runtime"].status, "blocked");
  assert.equal(byId["core/runtime"].terminalWriteOrReviewCount, 3);
  assert.deepEqual(model.remaining, [
    "write _root",
    "review _root",
    "review core/runtime",
    "changes_requested core/runtime",
    "blocked core/runtime",
  ]);
  assert.equal(model.directWriteAllowed, true);
  assert.equal(model.delegatedTaskCount, 3);
  assert.equal(model.delegateBatchCount, 1);
});

test("sorts clusters, cluster paths, and tasks independently of input order", () => {
  const model = sampleModel();
  model.clusters = [
    {
      id: "core/runtime",
      paths: ["core/runtime/module.md", "core/runtime/concept.md"],
      status: "writing",
      terminalWriteOrReviewCount: 1,
    },
    {
      id: "core",
      paths: ["overview.md"],
      status: "accepted",
      terminalWriteOrReviewCount: 0,
    },
  ];
  model.tasks = [...model.tasks].reverse();
  assert.equal(renderWikiBoard(model), expectedBoard);
});
