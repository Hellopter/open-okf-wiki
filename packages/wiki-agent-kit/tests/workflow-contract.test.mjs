import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflows = path.resolve(__dirname, "../workflows");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadWorkflow(name) {
  const source = fs.readFileSync(path.join(workflows, name), "utf8");
  const body = source.replace(/export const meta = \{[\s\S]*?\n\};\n/, "");
  return { source, run: new AsyncFunction("agent", "parallel", "phase", "log", "args", body) };
}

function successfulAgent(_prompt, options = {}) {
  if (options.label === "load-inventory") {
    return { units: [{ id: "app", kind: "source" }], tier: "L1", sourceCount: 1 };
  }
  if (String(options.label).startsWith("reduce-defects:")) {
    return { status: "ok", path: "analysis/defects.json", summary: "clean", clean: true, blockingCount: 0 };
  }
  return { status: "ok", path: "analysis/receipt.json", summary: "ok", digest: "d" };
}

describe("Claude workflow contracts", () => {
  it("runs the Discover/Plan workflow only through its planning boundary", async () => {
    const { source, run } = loadWorkflow("wiki-plan.workflow.js");
    assert.match(source, /name: "wiki-plan"/);
    assert.doesNotMatch(source, /wiki-produce/);
    assert.doesNotMatch(source, /ow plan/);
    assert.match(source, /\$\{workdir\}\/analysis\/receipts\/survey/);
    const phases = [];
    const output = await run(
      successfulAgent,
      async (tasks) => Promise.all(tasks.map((task) => task())),
      (name) => phases.push(name),
      () => {},
      { runId: "run-1", workdir: "/workdir" },
    );
    assert.deepEqual(phases, ["Discover", "Plan"]);
    assert.match(output.next, /ow gate plan --run run-1/);
    assert.equal(output.spec.status, "ok");
  });

  it("fans independent surveys out in waves of eight", async () => {
    const { run } = loadWorkflow("wiki-plan.workflow.js");
    const units = Array.from({ length: 9 }, (_, index) => ({ id: `unit-${index}`, kind: "source" }));
    const waveSizes = [];
    const agent = (prompt, options = {}) => {
      if (options.label === "load-inventory") return { units, tier: "L2", sourceCount: 1 };
      return successfulAgent(prompt, options);
    };
    const output = await run(
      agent,
      async (tasks) => {
        waveSizes.push(tasks.length);
        return Promise.all(tasks.map((task) => task()));
      },
      () => {},
      () => {},
      { runId: "run-8", workdir: "/workdir" },
    );
    assert.deepEqual(waveSizes, [8, 1]);
    assert.equal(output.ledger.length, 9);
  });

  it("runs gated write/review to validation when every stage is clean", async () => {
    const { source, run } = loadWorkflow("wiki-write-review.workflow.js");
    assert.match(source, /name: "wiki-write-review"/);
    assert.match(source, /gate-plan\.ok\.json/);
    assert.doesNotMatch(source, /ow write/);
    assert.match(source, /hostCli\.workspaceRoot/);
    const phases = [];
    const output = await run(
      successfulAgent,
      async (tasks) => Promise.all(tasks.map((task) => task())),
      (name) => phases.push(name),
      () => {},
      { runId: "run-2", workdir: "/workdir" },
    );
    assert.deepEqual(phases, ["Preflight", "Write", "Review", "Validate"]);
    assert.equal(output.validation.status, "ok");
  });

  it("fails closed when a workflow is invoked without frozen-run arguments", async () => {
    const { run } = loadWorkflow("wiki-plan.workflow.js");
    const output = await run(successfulAgent, async () => [], () => {}, () => {}, {});
    assert.match(output.stopped, /runId and absolute workdir/);
  });
});
