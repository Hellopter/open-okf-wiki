import assert from "node:assert/strict";
import test from "node:test";
import { WIKI_WORKFLOW_SCRIPT } from "../dist/wiki-workflow.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WORKFLOW_BODY = WIKI_WORKFLOW_SCRIPT.replace(/^export const meta = \{[\s\S]*?\n\};\n\n/, "");

const OK = { status: "ok", summary: "ok" };
const ASSIGNMENTS = {
  status: "ok",
  summary: "assignments loaded",
  limits: { maxRepairRounds: 2 },
  shards: [{ owner: "source:api", role: "domain", pagePaths: ["api.md"] }],
};
const REPAIR_TARGETS = [{ owner: "source:api", pagePaths: ["api.md"] }];

function review(clean, fingerprint = "", counts = {}) {
  return {
    status: "ok",
    summary: clean ? "clean" : "repair required",
    clean,
    blockingCount: clean ? 0 : (counts.blockingCount ?? 1),
    majorCount: clean ? 0 : (counts.majorCount ?? 0),
    defectFingerprint: fingerprint,
    repairTargets: clean ? [] : REPAIR_TARGETS,
  };
}

async function runReviewHarness({ startAt, reviewResults, resumeRepair = false, mode = "auto" }) {
  const labels = [];
  const prompts = new Map();
  const remainingReviews = [...reviewResults];
  const workflow = new AsyncFunction("args", "agent", "parallel", "phase", "log", WORKFLOW_BODY);

  const agent = async (prompt, options = {}) => {
    const label = options.label;
    labels.push(label);
    prompts.set(label, prompt);

    if (label === "bootstrap-prepare") {
      assert.match(prompt, /Tool: okf_prepare/);
      return { status: "ok", runId: "domain-1", workdir: "/work/domain-1", workspaceRoot: "/work", mode, startAt };
    }
    if (label === "load-page-assignments") return ASSIGNMENTS;
    if (label?.startsWith("review:")) return OK;
    if (label?.startsWith("reduce-review:")) return remainingReviews.shift();
    if (label === "hydrate-repair:1") {
      assert.equal(resumeRepair, true);
      return review(false, "defects-round-1");
    }
    if (label?.startsWith("repair:") || label?.startsWith("repair-resume:")) return OK;
    if (label?.startsWith("reduce-repair")) return OK;
    if (label?.startsWith("publish:")) {
      assert.match(prompt, /Tool: okf_publish/);
      return OK;
    }
    if (label === "validate-candidate") {
      assert.match(prompt, /Tool: okf_validate/);
      return OK;
    }
    assert.fail(`Unexpected workflow agent: ${label}`);
  };

  const result = await workflow(
    { request: { mode } },
    agent,
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
    () => {},
  );
  return { result, labels, prompts };
}

test("executes review, repair, clean review, and validate through host-published checkpoint edges", async () => {
  const { result, labels, prompts } = await runReviewHarness({
    startAt: "review-1",
    reviewResults: [review(false, "defects-round-1"), review(true)],
  });

  assert.equal(result.status, "ok");
  assert.ok(labels.indexOf("load-page-assignments") < labels.indexOf("review:1:source-claims"));
  assert.deepEqual(
    labels.filter((label) => label?.startsWith("publish:")),
    ["publish:review-1", "publish:repair-1", "publish:review-2", "publish:validate"],
  );
  assert.match(prompts.get("reduce-review:1"), /never include analysis\/defects\.json/);
});

test("plan mode stops at an already-approved ready checkpoint before loading assignments or writers", async () => {
  const { result, labels } = await runReviewHarness({
    startAt: "ready",
    mode: "plan",
    reviewResults: [],
  });

  assert.equal(result.status, "ok");
  assert.equal(result.next, "/wiki --write");
  assert.deepEqual(labels, ["bootstrap-prepare"]);
});

test("resumes at repair-1, reloads assignments, then verifies review-2 before validation", async () => {
  const { result, labels } = await runReviewHarness({
    startAt: "repair-1",
    resumeRepair: true,
    reviewResults: [review(true)],
  });

  assert.equal(result.status, "ok");
  assert.ok(labels.indexOf("load-page-assignments") < labels.indexOf("hydrate-repair:1"));
  assert.ok(labels.includes("repair-resume:1:0"));
  assert.equal(labels.includes("reduce-review:1"), false);
  assert.deepEqual(
    labels.filter((label) => label?.startsWith("publish:")),
    ["publish:repair-1", "publish:review-2", "publish:validate"],
  );
});

test("allows the method's second repair before the final clean review", async () => {
  const { result, labels } = await runReviewHarness({
    startAt: "review-1",
    reviewResults: [
      review(false, "defects-round-1", { blockingCount: 2 }),
      review(false, "defects-round-2", { blockingCount: 1 }),
      review(true),
    ],
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(
    labels.filter((label) => label?.startsWith("publish:")),
    ["publish:review-1", "publish:repair-1", "publish:review-2", "publish:repair-2", "publish:review-3", "publish:validate"],
  );
});
