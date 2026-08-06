import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(__dirname, "../workflows/wiki.workflow.js");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const DEFAULT_LIMITS = {
  batchConcurrency: 4,
  perSourceConcurrency: 2,
  maxCoveragePasses: 2,
  maxRepairRounds: 2,
};

function loadWorkflow() {
  const source = fs.readFileSync(workflowPath, "utf8");
  const body = source.replace(/export const meta = \{[\s\S]*?\n\};\n/, "");
  return { source, run: new AsyncFunction("agent", "parallel", "phase", "log", "args", body) };
}

function envelope(label) {
  return { status: "ok", summary: label };
}

function makeAgent({ startAt = "survey", reviews = [], inventory = null, discoveryMissing = [], hydrateDigest = `sha256:${"1".repeat(64)}` } = {}) {
  const labels = [];
  const prompts = [];
  let reviewIndex = 0;
  let discoveryPass = 0;
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
        inputCheckpointDigest: ["survey", "plan"].includes(startAt) ? null : `sha256:${"1".repeat(64)}`,
        summary: "prepared",
      };
    }
    if (label === "load-inventory") {
      return (
        inventory || {
          units: [{ id: "api", kind: "source", sourceId: "api" }],
          tier: "L1",
          sourceCount: 1,
          wikiLanguage: "en",
          focus: null,
          limits: DEFAULT_LIMITS,
        }
      );
    }
    if (label.startsWith("hydrate:review-")) {
      return {
        status: "ok",
        clean: false,
        checkpointDigest: hydrateDigest,
        blockingCount: 1,
        majorCount: 0,
        defectFingerprint: "resumed-review-fingerprint",
        repairTargets: [{ owner: "api", pagePaths: ["modules/api.md"] }],
        summary: "resumed review",
      };
    }
    if (label.startsWith("hydrate:")) {
      return {
        status: "ok",
        checkpointPath: "analysis/checkpoints/discover.json",
        checkpointDigest: hydrateDigest,
        wikiLanguage: "en",
        sourceCount: 1,
        tier: "L1",
        focus: null,
        limits: DEFAULT_LIMITS,
        summary: "resumed discovery",
      };
    }
    if (label.startsWith("reduce-discovery:")) {
      const missing = Array.isArray(discoveryMissing[discoveryPass])
        ? discoveryMissing[discoveryPass]
        : discoveryMissing;
      discoveryPass += 1;
      return { ...envelope(label), missingUnitIds: missing || [] };
    }
    if (label.startsWith("publish:")) {
      return {
        status: "ok",
        checkpointPath: `analysis/checkpoints/${label}.json`,
        checkpointDigest: `sha256:${"a".repeat(64)}`,
        summary: label,
      };
    }
    if (label === "load-page-assignments") {
      return {
        wikiLanguage: "en",
        sourceCount: 1,
        tier: "L1",
        limits: DEFAULT_LIMITS,
        shards: [
          { owner: "api", role: "domain", pagePaths: ["modules/api.md"], dependsOn: ["survey-api"] },
          { owner: "integration", role: "integration", pagePaths: ["overview.md"], dependsOn: ["survey-api"] },
        ],
      };
    }
    if (label.startsWith("reduce-defects:")) {
      const review =
        reviews[reviewIndex++] || {
          clean: true,
          blockingCount: 0,
          majorCount: 0,
          defectFingerprint: "clean-fingerprint-000",
        };
      return {
        ...envelope(label),
        ...review,
        repairTargets: review.repairTargets || [],
      };
    }
    if (label.startsWith("survey:")) {
      // Default ok; callers may wrap agent for custom survey failures.
      return envelope(label);
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
    assert.match(source, /<hostCli\.node> <hostCli\.script> publish/);
    assert.match(source, /--artifacts-json \$\{artifactsJson\}/);
    assert.match(source, /inputCheckpointDigest/);
    assert.match(source, /scheduleWaves/);
    assert.doesNotMatch(source, /MAX_CONCURRENCY|function waves\(/);
    assert.doesNotMatch(source, /handoff|checkpoint --phase|blocked-\$\{round\}/);
    assert.deepEqual(phases, ["Bootstrap", "Survey", "Plan", "Write", "Verify", "Validate"]);
    assert.ok(labels.includes("publish:discover"));
    assert.ok(labels.includes("publish:plan"));
    assert.ok(labels.includes("publish:write-sources"));
    assert.ok(labels.includes("publish:write"));
    assert.ok(labels.some((l) => String(l).startsWith("publish:review")));
    assert.ok(labels.includes("publish:validate"));
    assert.equal(result.next, "sealed");
  });

  it("accepts command-string plan mode and stops at the plan checkpoint", async () => {
    const { labels, phases, prompts, result } = await runWorkflow("--plan authentication flow");
    assert.deepEqual(phases, ["Bootstrap", "Survey", "Plan"]);
    assert.ok(labels.includes("publish:plan"));
    assert.ok(!labels.includes("preflight-write"));
    assert.equal(result.next, "/wiki --write");
    assert.ok(
      prompts.some((prompt) =>
        /Requested business input: \{"mode":"plan","focus":"authentication flow"\}/.test(prompt),
      ),
    );
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
    assert.ok(labels.includes("publish:validate"));
    assert.ok(labels.includes("validate-and-seal"));
    assert.ok(!labels.includes("load-inventory"));
    assert.ok(!labels.includes("plan-spec"));
    assert.ok(!labels.includes("preflight-write"));
    assert.ok(!labels.some((label) => label.startsWith("review-")));
    assert.equal(result.next, "sealed");
  });

  it("resumes each published boundary without replaying its predecessor", async () => {
    const gate = await runWorkflow("", { startAt: "gate" });
    assert.ok(gate.labels.includes("hydrate:gate"));
    assert.ok(gate.labels.includes("gate-plan"));
    assert.ok(!gate.labels.includes("plan-spec"));

    const writeSources = await runWorkflow("", { startAt: "write-sources" });
    assert.ok(writeSources.labels.includes("publish:write-sources"));
    assert.ok(!writeSources.labels.includes("load-inventory"));
    assert.ok(!writeSources.labels.includes("plan-spec"));

    const write = await runWorkflow("", { startAt: "write" });
    assert.ok(write.labels.includes("publish:write"));
    assert.ok(!write.labels.includes("publish:write-sources"));
    assert.ok(!write.labels.some((label) => String(label).startsWith("write:domain:")));

    const review = await runWorkflow("", { startAt: "review-1" });
    assert.ok(review.labels.some((label) => String(label).startsWith("publish:review-1")));
    assert.ok(!review.labels.some((label) => String(label).startsWith("write:")));

    const repair = await runWorkflow("", { startAt: "repair-1" });
    assert.ok(repair.labels.includes("hydrate:review-1"));
    assert.ok(repair.labels.includes("repair:1:api"));
    assert.ok(!repair.labels.some((label) => String(label).startsWith("review:page:1:")));
  });

  it("fails closed when a resumed checkpoint digest is not the prepared digest", async () => {
    const { labels, result } = await runWorkflow("", {
      startAt: "write",
      hydrateDigest: `sha256:${"f".repeat(64)}`,
    });
    assert.ok(labels.includes("hydrate:write"));
    assert.equal(result.stopped, "cannot hydrate write");
    assert.ok(!labels.includes("preflight-write"));
  });

  it("fans surveys in policy-sized waves and propagates the language policy", async () => {
    const { run } = loadWorkflow();
    const units = Array.from({ length: 9 }, (_, index) => ({
      id: `unit-${index}`,
      kind: "source",
      sourceId: "api",
    }));
    const harness = makeAgent();
    const baseAgent = harness.agent;
    harness.agent = async (prompt, options) => {
      if (options?.label === "load-inventory") {
        return {
          units,
          tier: "L3",
          sourceCount: 2,
          wikiLanguage: "zh",
          focus: "认证",
          limits: { batchConcurrency: 4, perSourceConcurrency: 2, maxCoveragePasses: 2, maxRepairRounds: 2 },
        };
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
    // Single sourceId + perSourceConcurrency=2 => waves of 2 until drained (9 units → 5 waves of 2,2,2,2,1).
    assert.deepEqual(waveSizes.slice(0, 5), [2, 2, 2, 2, 1]);
    assert.ok(harness.prompts.some((prompt) => /wikiLanguage=zh/.test(prompt)));
    assert.ok(harness.prompts.some((prompt) => /MULTI-SOURCE DEEP ANALYSIS REQUIRED/.test(prompt)));
  });

  it("interleaves multi-source survey waves under per-source caps", async () => {
    const { run } = loadWorkflow();
    const units = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `a-${i}`,
        kind: "source",
        sourceId: "A",
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `b-${i}`,
        kind: "source",
        sourceId: "B",
      })),
    ];
    const harness = makeAgent();
    const baseAgent = harness.agent;
    harness.agent = async (prompt, options) => {
      if (options?.label === "load-inventory") {
        return {
          units,
          tier: "L3",
          sourceCount: 2,
          wikiLanguage: "en",
          focus: null,
          limits: { batchConcurrency: 4, perSourceConcurrency: 2, maxCoveragePasses: 2, maxRepairRounds: 2 },
        };
      }
      return baseAgent(prompt, options);
    };
    const firstWaveLabels = [];
    let capturedFirst = false;
    await run(
      harness.agent,
      async (tasks) => {
        const isSurveyWave = tasks.length && tasks.every((task) => String(task).includes("survey"));
        if (isSurveyWave && !capturedFirst) {
          capturedFirst = true;
          // Run tasks so labels are recorded in order for this wave
          const results = await Promise.all(tasks.map((task) => task()));
          const waveLabels = harness.labels.filter((l) => String(l).startsWith("survey:1:"));
          firstWaveLabels.push(...waveLabels);
          return results;
        }
        return Promise.all(tasks.map((task) => task()));
      },
      () => {},
      () => {},
      "",
    );
    const wave1 = firstWaveLabels;
    assert.ok(wave1.length <= 4);
    const aCount = wave1.filter((l) => /survey:1:a-/.test(l)).length;
    const bCount = wave1.filter((l) => /survey:1:b-/.test(l)).length;
    assert.ok(aCount > 0 && bCount > 0, `expected both sources in first wave, got ${JSON.stringify(wave1)}`);
    assert.ok(aCount <= 2, `per-source A cap broken: ${aCount}`);
    assert.ok(bCount <= 2, `per-source B cap broken: ${bCount}`);
  });

  it("surveys every inventory coverage unit on pass 1 including surfaces", async () => {
    const inventory = {
      units: [
        { id: "app", kind: "source", sourceId: "app" },
        { id: "svc", kind: "source", sourceId: "svc" },
        { id: "app::packages/core", kind: "surface", sourceId: "app", path: "packages/core" },
        { id: "app::packages/api", kind: "surface", sourceId: "app", path: "packages/api" },
        { id: "svc::web", kind: "surface", sourceId: "svc", path: "web" },
      ],
      tier: "L3",
      sourceCount: 2,
      wikiLanguage: "en",
      focus: null,
      limits: DEFAULT_LIMITS,
    };
    const { labels } = await runWorkflow("", { inventory, discoveryMissing: [[], []] });
    const pass1 = labels.filter((l) => String(l).startsWith("survey:1:")).sort();
    assert.deepEqual(
      pass1,
      [
        "survey:1:app",
        "survey:1:app::packages-api",
        "survey:1:app::packages-core",
        "survey:1:svc",
        "survey:1:svc::web",
      ].sort(),
    );
  });

  it("retries rate-limited units on pass 2 without re-running permanent failures", async () => {
    const inventory = {
      units: [
        { id: "app", kind: "source", sourceId: "app" },
        { id: "app::pkg", kind: "surface", sourceId: "app", path: "pkg" },
        { id: "svc", kind: "source", sourceId: "svc" },
      ],
      tier: "L3",
      sourceCount: 2,
      wikiLanguage: "en",
      focus: null,
      limits: DEFAULT_LIMITS,
    };
    const { run } = loadWorkflow();
    const harness = makeAgent({ inventory, discoveryMissing: [[], []] });
    const baseAgent = harness.agent;
    harness.agent = async (prompt, options) => {
      if (options?.label === "survey:1:app") {
        harness.labels.push(options.label);
        harness.prompts.push(prompt);
        return {
          status: "failed",
          receiptPath: "analysis/receipts/survey/app-pass-1.json",
          summary: "provider rate limit 429 overloaded",
          openQuestions: [],
        };
      }
      if (options?.label === "survey:1:svc") {
        harness.labels.push(options.label);
        harness.prompts.push(prompt);
        return {
          status: "failed",
          receiptPath: "analysis/receipts/survey/svc-pass-1.json",
          summary: "module not found in frozen snapshot",
          openQuestions: [],
        };
      }
      return baseAgent(prompt, options);
    };
    await run(
      harness.agent,
      async (tasks) => Promise.all(tasks.map((task) => task())),
      () => {},
      () => {},
      "",
    );
    const pass1 = harness.labels.filter((l) => String(l).startsWith("survey:1:"));
    assert.ok(pass1.includes("survey:1:app::pkg") || pass1.some((l) => String(l).includes("pkg")), `surface surveyed on pass1: ${JSON.stringify(pass1)}`);
    const pass2 = harness.labels.filter((l) => String(l).startsWith("survey:2:"));
    assert.ok(pass2.includes("survey:2:app"), `rate-limited app should retry: ${JSON.stringify(pass2)}`);
    assert.ok(!pass2.includes("survey:2:svc"), `permanent failure must not auto-retry: ${JSON.stringify(pass2)}`);
  });

  it("repairs routed owners only when review metrics progress", async () => {
    const reviews = [
      {
        clean: false,
        blockingCount: 1,
        majorCount: 0,
        defectFingerprint: "first-fingerprint-000",
        repairTargets: [{ owner: "api", pagePaths: ["modules/api.md"] }],
      },
      { clean: true, blockingCount: 0, majorCount: 0, defectFingerprint: "clean-fingerprint-000" },
    ];
    const { phases, labels, prompts, result } = await runWorkflow("", { reviews });
    assert.ok(phases.includes("Repair"));
    assert.ok(labels.includes("repair:1:api"));
    assert.ok(prompts.some((prompt) => /only these candidate pages: \["modules\/api\.md"\]/.test(prompt)));
    assert.equal(result.next, "sealed");
  });

  it("records a blocker instead of looping when a review fingerprint makes no progress", async () => {
    const repeated = {
      clean: false,
      blockingCount: 1,
      majorCount: 0,
      defectFingerprint: "same-fingerprint-0000",
      repairTargets: [{ owner: "api", pagePaths: ["modules/api.md"] }],
    };
    const { labels, result } = await runWorkflow("", { reviews: [repeated, repeated] });
    assert.ok(labels.includes("record-blocked:2"));
    assert.match(result.stopped, /no measurable progress/i);
    assert.ok(!labels.includes("validate-and-seal"));
  });
});
