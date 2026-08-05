import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(__dirname, "../workflows/wiki.workflow.js");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadWorkflow() {
  const source = fs.readFileSync(workflowPath, "utf8");
  const body = source.replace(/export const meta = \{[\s\S]*?\n\};\n/, "");
  return { source, run: new AsyncFunction("agent", "parallel", "phase", "log", "args", body) };
}

function envelope(label) {
  return { status: "ok", proposalPath: `analysis/handoffs/${label}.json`, summary: label, openQuestions: [] };
}

function makeAgent({ startAt = "survey", reviews = [] } = {}) {
  const labels = [];
  const prompts = [];
  let reviewIndex = 0;
  const agent = async (prompt, options = {}) => {
    labels.push(options.label);
    prompts.push(prompt);
    const label = String(options.label || "");
    if (label === "bootstrap-prepare") {
      return {
        status: "ok",
        runId: "run-1",
        workdir: "/workdir",
        workspaceRoot: "/workspace",
        mode: "auto",
        startAt,
        inputCheckpointDigest: ["write", "validate"].includes(startAt) ? `sha256:${"1".repeat(64)}` : null,
        summary: "prepared",
      };
    }
    if (label === "load-inventory") {
      return { units: [{ id: "api", kind: "source", sourceId: "api" }], tier: "L1", sourceCount: 1, wikiLanguage: "en", focus: null };
    }
    if (label.startsWith("reduce-discovery:")) return { ...envelope(label), missingUnitIds: [] };
    if (label.startsWith("checkpoint-")) return { status: "ok", checkpointPath: `analysis/checkpoints/${label}.json`, checkpointDigest: `sha256:${"a".repeat(64)}`, summary: label };
    if (label === "load-page-assignments") {
      return {
        wikiLanguage: "en",
        sourceCount: 1,
        shards: [
          { owner: "api", role: "domain", pagePaths: ["modules/api.md"], dependsOn: ["survey-api"] },
          { owner: "integration", role: "integration", pagePaths: ["overview.md"], dependsOn: ["survey-api"] },
        ],
      };
    }
    if (label.startsWith("reduce-defects:")) {
      const review = reviews[reviewIndex++] || { clean: true, blockingCount: 0, majorCount: 0, defectFingerprint: "clean-fingerprint-000" };
      return {
        ...envelope(label),
        ...review,
        repairTargets: review.repairTargets || [],
      };
    }
    return envelope(label || "agent");
  };
  return { agent, labels, prompts };
}

async function runWorkflow(args, options = {}) {
  const loaded = loadWorkflow();
  const { run } = loaded;
  const harness = makeAgent(options);
  const phases = [];
  const waveSizes = [];
  const result = await run(
    harness.agent,
    async (tasks) => {
      waveSizes.push(tasks.length);
      return Promise.all(tasks.map((task) => task()));
    },
    (phase) => phases.push(phase),
    () => {},
    args,
  );
  return { ...harness, source: loaded.source, phases, waveSizes, result };
}

describe("wiki dynamic workflow contract", () => {
  it("exposes one native workflow and executes a checkpointed happy path", async () => {
    const { source, phases, labels, result } = await runWorkflow("");
    assert.match(source, /name: "wiki"/);
    assert.doesNotMatch(source, /wiki-produce|wiki-write-review|wiki-plan/);
    assert.match(source, /checkpoint --phase/);
    assert.match(source, /inputCheckpointDigest/);
    assert.deepEqual(phases, ["Bootstrap", "Survey", "Plan", "Write", "Verify", "Validate"]);
    assert.ok(labels.includes("checkpoint-discover"));
    assert.ok(labels.includes("checkpoint-plan"));
    assert.ok(labels.includes("checkpoint-write-sources"));
    assert.ok(labels.includes("checkpoint-write"));
    assert.ok(labels.includes("checkpoint-review:1"));
    assert.ok(labels.includes("checkpoint-validate"));
    assert.equal(result.next, "sealed");
  });

  it("accepts command-string plan mode and stops at the plan checkpoint", async () => {
    const { labels, phases, prompts, result } = await runWorkflow("--plan authentication flow");
    assert.deepEqual(phases, ["Bootstrap", "Survey", "Plan"]);
    assert.ok(labels.includes("checkpoint-plan"));
    assert.ok(!labels.includes("preflight-write"));
    assert.equal(result.next, "/wiki --write");
    assert.ok(prompts.some((prompt) => /Requested business input: \{"mode":"plan","focus":"authentication flow"\}/.test(prompt)));
  });

  it("accepts structured write mode and never re-surveys a write-ready checkpoint", async () => {
    const { labels, phases, result } = await runWorkflow({ mode: "write" }, { startAt: "write" });
    assert.deepEqual(phases, ["Bootstrap", "Write", "Verify", "Validate"]);
    assert.ok(labels.includes("preflight-write"));
    assert.ok(!labels.includes("load-inventory"));
    assert.ok(!labels.includes("plan-spec"));
    assert.equal(result.next, "sealed");
  });

  it("resumes an interrupted validated candidate directly through its terminal checkpoint", async () => {
    const { phases, labels, result } = await runWorkflow("", { startAt: "validate" });
    assert.deepEqual(phases, ["Bootstrap", "Validate"]);
    assert.ok(labels.includes("validate-and-seal"));
    assert.ok(labels.includes("checkpoint-validate"));
    assert.ok(!labels.includes("load-inventory"));
    assert.ok(!labels.includes("plan-spec"));
    assert.ok(!labels.includes("preflight-write"));
    assert.ok(!labels.some((label) => label.startsWith("review-")));
    assert.equal(result.next, "sealed");
  });

  it("fans surveys in bounded waves and propagates the language policy", async () => {
    const { run } = loadWorkflow();
    const units = Array.from({ length: 9 }, (_, index) => ({ id: `unit-${index}`, kind: "source", sourceId: "api" }));
    const harness = makeAgent();
    const baseAgent = harness.agent;
    harness.agent = async (prompt, options) => {
      if (options?.label === "load-inventory") {
        return { units, tier: "L3", sourceCount: 2, wikiLanguage: "zh", focus: "认证" };
      }
      return baseAgent(prompt, options);
    };
    const waveSizes = [];
    await run(
      harness.agent,
      async (tasks) => {
        const isSurveyWave = tasks.length && tasks.every((task) => String(task).includes("survey"));
        if (isSurveyWave) waveSizes.push(tasks.length);
        return Promise.all(tasks.map((task) => task()));
      },
      () => {},
      () => {},
      "",
    );
    assert.deepEqual(waveSizes.slice(0, 2), [8, 1]);
    assert.ok(harness.prompts.some((prompt) => /wikiLanguage=zh/.test(prompt)));
    assert.ok(harness.prompts.some((prompt) => /MULTI-SOURCE DEEP ANALYSIS REQUIRED/.test(prompt)));
  });

  it("repairs routed owners only when review metrics progress", async () => {
    const reviews = [
      { clean: false, blockingCount: 1, majorCount: 0, defectFingerprint: "first-fingerprint-000", repairTargets: [{ owner: "api", pagePaths: ["modules/api.md"] }] },
      { clean: true, blockingCount: 0, majorCount: 0, defectFingerprint: "clean-fingerprint-000" },
    ];
    const { phases, labels, prompts, result } = await runWorkflow("", { reviews });
    assert.ok(phases.includes("Repair"));
    assert.ok(labels.includes("repair:1:api"));
    assert.ok(prompts.some((prompt) => /only these candidate pages: \["modules\/api\.md"\]/.test(prompt)));
    assert.equal(result.next, "sealed");
  });

  it("records a blocker instead of looping when a review fingerprint makes no progress", async () => {
    const repeated = { clean: false, blockingCount: 1, majorCount: 0, defectFingerprint: "same-fingerprint-0000", repairTargets: [{ owner: "api", pagePaths: ["modules/api.md"] }] };
    const { labels, result } = await runWorkflow("", { reviews: [repeated, repeated] });
    assert.ok(labels.includes("record-blocked:2"));
    assert.match(result.stopped, /no measurable progress/i);
    assert.ok(!labels.includes("validate-and-seal"));
  });
});
