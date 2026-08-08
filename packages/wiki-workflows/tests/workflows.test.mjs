import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { parseCommand } from "../dist/cli.js";
import {
  WIKI_GENERATE_WORKFLOW,
  WIKI_REFRESH_WORKFLOW,
  WIKI_WORKFLOW_DEFINITIONS,
  installWikiWorkflows,
} from "../dist/index.js";
import {
  parseWorkflowScript,
  runWorkflow,
} from "@quintinshaw/pi-dynamic-workflows";

test("saved Wiki workflows are valid dynamic-workflow scripts", () => {
  for (const [script, expected] of [
    [WIKI_GENERATE_WORKFLOW, "wiki_generate"],
    [WIKI_REFRESH_WORKFLOW, "wiki_refresh"],
  ]) {
    const { meta } = parseWorkflowScript(script);
    assert.equal(meta.name, expected);
    assert.ok(meta.phases?.some((phase) => phase.title === "Plan"));
    assert.ok(meta.phases?.some((phase) => phase.title === "Finalize"));
    assert.match(script, /await parallel\(/);
    assert.match(script, /await gate\(/);
    assert.match(script, /repo:src\/foo\.ts#L12-L30/);
    assert.match(script, /retries: 1/);
    assert.match(script, /exact process exitCode/);
  }
});

test("generate workflow fans out at four research scopes at most and finalizes after a clean review", async () => {
  const labels = [];
  const runner = {
    async run(_prompt, options) {
      labels.push(options.label);
      if (options.label === "plan:initial") {
        return {
          pages: [{ path: "overview.md", title: "Overview", purpose: "entry", sources: ["src/index.ts#L1-L1"] }],
          researchScopes: [
            { id: "one", task: "one" },
            { id: "two", task: "two" },
            { id: "three", task: "three" },
            { id: "four", task: "four" },
            { id: "five", task: "five" },
          ],
          rationale: "test",
        };
      }
      if (String(options.label).startsWith("research:")) return "evidence";
      if (String(options.label).startsWith("write:")) return { updatedPages: ["overview.md"], deletedPages: [], notes: [] };
      if (String(options.label).startsWith("review:")) return { defects: [], summary: "clean" };
      if (String(options.label).startsWith("finalize:")) {
        return { exitCode: 0, validation: { ok: true, errors: [], pages: ["overview.md"] } };
      }
      throw new Error(`unexpected label: ${options.label}`);
    },
  };

  const outcome = await runWorkflow(WIKI_GENERATE_WORKFLOW, {
    agent: runner,
    args: { lang: "zh" },
    persistLogs: false,
  });

  assert.equal(outcome.result.ok, true);
  assert.equal(labels.filter((label) => String(label).startsWith("research:")).length, 4);
  assert.deepEqual(labels, [
    "plan:initial",
    "research:1:one",
    "research:2:two",
    "research:3:three",
    "research:4:four",
    "write:initial",
    "review:1",
    "finalize:1",
  ]);
});

test("review topology defects trigger one replan while local defects use repair", async () => {
  const labels = [];
  let planCount = 0;
  let reviewCount = 0;
  const runner = {
    async run(_prompt, options) {
      labels.push(options.label);
      if (options.label === "plan:initial" || options.label === "replan:1") {
        planCount++;
        return {
          pages: [{ path: "overview.md", title: "Overview", purpose: "entry", sources: ["src/index.ts#L1-L1"] }],
          researchScopes: [],
          rationale: "test",
        };
      }
      if (String(options.label).startsWith("write:")) return { updatedPages: ["overview.md"], deletedPages: [], notes: [] };
      if (options.label === "repair:local") return { updatedPages: ["overview.md"], deletedPages: [], notes: [] };
      if (String(options.label).startsWith("review:")) {
        reviewCount++;
        if (reviewCount === 1) {
          return { defects: [{ id: "topology", page: "overview.md", kind: "topology", detail: "missing page" }], summary: "replan" };
        }
        return { defects: [], summary: "clean" };
      }
      if (String(options.label).startsWith("finalize:")) {
        return { exitCode: 0, validation: { ok: true, errors: [], pages: ["overview.md"] } };
      }
      throw new Error(`unexpected label: ${options.label}`);
    },
  };

  const outcome = await runWorkflow(WIKI_REFRESH_WORKFLOW, { agent: runner, persistLogs: false });

  assert.equal(outcome.result.ok, true);
  assert.equal(planCount, 2);
  assert.deepEqual(labels, ["plan:initial", "write:initial", "review:1", "replan:1", "write:replanned", "review:2", "finalize:1"]);
});

test("a nonzero finalizer exit code fails the workflow even when review passed", async () => {
  let finalizerCalls = 0;
  const runner = {
    async run(_prompt, options) {
      if (options.label === "plan:initial") {
        return {
          pages: [{ path: "overview.md", title: "Overview", purpose: "entry", sources: ["src/index.ts#L1-L1"] }],
          researchScopes: [],
          rationale: "test",
        };
      }
      if (options.label === "write:initial") return { updatedPages: ["overview.md"], deletedPages: [], notes: [] };
      if (options.label === "review:1") return { defects: [], summary: "clean" };
      if (String(options.label).startsWith("finalize:")) {
        finalizerCalls++;
        return { exitCode: 1, validation: { ok: false, errors: ["broken citation"], pages: ["overview.md"] } };
      }
      throw new Error(`unexpected label: ${options.label}`);
    },
  };

  const outcome = await runWorkflow(WIKI_GENERATE_WORKFLOW, { agent: runner, persistLogs: false });

  assert.equal(outcome.result.ok, false);
  assert.equal(finalizerCalls, 2, "the bounded finalization gate must not accept a nonzero command exit");
});

test("a finalizer success claim without command evidence fails the workflow", async () => {
  let finalizerCalls = 0;
  const runner = {
    async run(_prompt, options) {
      if (options.label === "plan:initial") {
        return {
          pages: [{ path: "overview.md", title: "Overview", purpose: "entry", sources: ["src/index.ts#L1-L1"] }],
          researchScopes: [],
          rationale: "test",
        };
      }
      if (options.label === "write:initial") return { updatedPages: ["overview.md"], deletedPages: [], notes: [] };
      if (options.label === "review:1") return { defects: [], summary: "clean" };
      if (String(options.label).startsWith("finalize:")) {
        finalizerCalls++;
        return { ok: true };
      }
      throw new Error(`unexpected label: ${options.label}`);
    },
  };

  const outcome = await runWorkflow(WIKI_GENERATE_WORKFLOW, { agent: runner, persistLogs: false });

  assert.equal(outcome.result.ok, false);
  assert.equal(finalizerCalls, 2, "a finalizer must provide command exit and validation evidence");
});

test("installer definitions register both commands with Chinese as the default language", () => {
  assert.deepEqual(WIKI_WORKFLOW_DEFINITIONS.map((workflow) => workflow.name), ["wiki-generate", "wiki-refresh"]);
  for (const workflow of WIKI_WORKFLOW_DEFINITIONS) {
    assert.equal(workflow.parameters.lang.default, "zh");
  }
});

test("installer binds saved workflows to the installed CLI rather than a PATH-dependent bin", () => {
  const saved = [];
  installWikiWorkflows("/workspace", {
    save(workflow) {
      saved.push(workflow);
      return { ...workflow, path: `/saved/${workflow.name}.json`, savedAt: "now" };
    },
  });

  assert.match(saved[0].script, /dist\/cli\.js' inspect --json/);
  assert.match(saved[1].script, /dist\/cli\.js' finalize --json/);
  assert.doesNotMatch(saved[0].script, /Run `okf-wiki inspect/);
});

test("CLI parses project workspace options and keeps Wiki output fixed", () => {
  assert.deepEqual(parseCommand(["inspect", "--cwd", "test-workspace"]), {
    command: "inspect",
    cwd: new URL("../test-workspace", import.meta.url).pathname,
    wikiDirectory: "wiki",
  });
  assert.throws(() => parseCommand(["finalize", "--wiki", "wiki"]), /output is always wiki/);
});

test("compiled CLI can be invoked directly from the workspace package", () => {
  const output = execFileSync(process.execPath, ["dist/cli.js", "help"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(output).ok, true);
});
