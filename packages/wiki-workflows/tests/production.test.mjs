import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePage } from "../dist/frontmatter.js";
import { createConfiguredWikiProducer } from "../dist/production.js";
import { createWikiRunSpecStore } from "../dist/run-spec-store.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-production-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function validPage(type = "Concept", title = "Runtime") {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "description: Runtime behavior",
    "sources:",
    "  - id: runtime-source",
    "    resource: repo:src/index.ts#L1-L1",
    "---",
    "",
    "The runtime exports its answer.[^runtime-source]",
    "",
    "[^runtime-source]: [Source](repo:src/index.ts#L1-L1)",
    "",
  ].join("\n");
}

function testSpec() {
  const page = (pageType, pagePath, title) => ({ pageType, path: pagePath, title, purpose: "Runtime behavior", readerQuestions: [], requiredFacets: [], findingIds: [] });
  return {
    version: 1,
    overview: page("overview", "overview.md", "Overview"),
    domains: [{ id: "runtime", title: "Runtime", purpose: "Runtime behavior", pages: [
      page("domain", "runtime/domain.md", "Runtime domain"),
      page("concept", "runtime/concepts/runtime.md", "Runtime"),
    ] }],
    crossLinks: [], sharedTerms: [], omissions: [],
  };
}

async function writeCandidate(request, content = validPage()) {
  const directory = path.join(request.candidateWikiRoot, "runtime", "concepts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(request.candidateWikiRoot, "overview.md"), validPage("Overview", "Overview"), "utf8");
  await writeFile(path.join(request.candidateWikiRoot, "runtime", "domain.md"), validPage("Domain", "Runtime domain"), "utf8");
  await writeFile(path.join(directory, "runtime.md"), content, "utf8");
  await createWikiRunSpecStore({ workspace: request.cwd }).save(request.runId, testSpec());
}

test("production rejects an invalid candidate before publication", async (t) => {
  const root = await fixture(t);
  const producer = createConfiguredWikiProducer({
    createLead: () => ({
      async run(request) {
        await writeCandidate(request, "# no frontmatter\n");
        return { kind: "complete", summary: "invalid" };
      },
    }),
  });
  const run = await producer.start({ cwd: root });
  await assert.rejects(run.result(), /Wiki finalization requires a valid target Wiki/);
  await assert.rejects(readFile(path.join(root, "wiki", "runtime", "runtime.md"), "utf8"), { code: "ENOENT" });
});

test("production passes workspace language and Agent policy to the Lead", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "api");
  await mkdir(source);
  await writeFile(path.join(source, "index.ts"), "export const api = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  await writeFile(path.join(root, "workspace.yaml"), [
    "version: 1",
    "language: zh",
    "defaultSourceIgnores: true",
    "wiki:",
    "  exclude: []",
    "  maxConcurrentAgents: 5",
    "  transientRetries: 3",
    "  baseRetryDelayMs: 2500",
    "  sessionTimeoutSeconds: 3600",
    "sources:",
    "  - path: api",
    "    origin:",
    "      type: link",
    `      localPath: ${JSON.stringify(source)}`,
    "",
  ].join("\n"));
  let prepared;
  const producer = createConfiguredWikiProducer({
    createLead(input) {
      prepared = input;
      return { async run() { throw new Error("stop after prepare"); } };
    },
  });

  await assert.rejects((await producer.start({ cwd: root })).result(), /stop after prepare/);
  assert.equal(prepared.language, "zh");
  assert.equal(prepared.maxConcurrentAgents, 5);
  assert.equal(prepared.transientRetries, 3);
  assert.equal(prepared.baseRetryDelayMs, 2500);
  assert.equal(prepared.sessionTimeoutMs, 3_600_000);
  assert.match(prepared.prompt, /Simplified Chinese/);
});

test("production publishes a Spec topology and preserves reserved log", async (t) => {
  const root = await fixture(t);
  const log = "# Change history\n\n- Added architecture documentation.\n";
  const producer = createConfiguredWikiProducer({
    createLead: () => ({
      async run(request) {
        await request.report("Writing architecture page", { stage: "lead" });
        await writeCandidate(request);
        await writeFile(path.join(request.candidateWikiRoot, "log.md"), log, "utf8");
        return { kind: "complete", summary: "root page" };
      },
    }),
  });

  const run = await producer.start({ cwd: root });
  const result = await run.result();
  const view = await run.view();
  assert.ok(view.progress);
  assert.equal(typeof view.progress.stage, "string");
  assert.deepEqual(result.pages, ["overview.md", "runtime/concepts/runtime.md", "runtime/domain.md"]);
  const published = parsePage(await readFile(path.join(root, "wiki", "runtime", "concepts", "runtime.md"), "utf8"));
  assert.equal(published.frontmatter.generated.by, "open-okf-wiki/1.0.0");
  assert.equal(published.frontmatter.verified.by, "process:open-okf-wiki");
  assert.equal(await readFile(path.join(root, "wiki", "log.md"), "utf8"), log);
  assert.match(await readFile(path.join(root, "wiki", "index.md"), "utf8"), /\[Overview\]\(\.\/overview\.md\)/);
});

test("incremental prepare injects the required published WikiSpec", async (t) => {
  const root = await fixture(t);
  const initial = createConfiguredWikiProducer({ createLead: () => ({
    async run(request) { await writeCandidate(request); return { kind: "complete", summary: "initial" }; },
  }) });
  await (await initial.start({ cwd: root, operation: "regenerate" })).result();

  let prepared;
  const update = createConfiguredWikiProducer({ createLead(input) {
    prepared = input;
    return { async run() { throw new Error("stop after incremental prepare"); } };
  } });
  await assert.rejects((await update.start({ cwd: root, operation: "update" })).result(), /stop after incremental prepare/);
  assert.deepEqual(prepared.priorWikiSpec, testSpec());
  assert.match(prepared.prompt, /Prior published WikiSpec for incremental planning/);
});

test("resume preserves the existing candidate instead of preparing it again", async (t) => {
  const root = await fixture(t);
  let attempt = 0;
  const producer = createConfiguredWikiProducer({
    createLead: () => ({
      async run(request) {
        attempt += 1;
        const page = path.join(request.candidateWikiRoot, "runtime", "concepts", "runtime.md");
        if (attempt === 1) {
          await writeCandidate(request);
          return { kind: "pause", reason: "quota", summary: "wait" };
        }
        assert.equal(await readFile(page, "utf8"), validPage());
        return { kind: "complete", summary: "resumed" };
      },
    }),
  });
  const run = await producer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await run.view()).status, "paused");
  await run.control("resume");
  const result = await run.result();
  assert.equal(result.summary, "resumed");
  assert.deepEqual(result.pages, ["overview.md", "runtime/concepts/runtime.md", "runtime/domain.md"]);
});

test("production rejects publication when repository sources drift", async (t) => {
  const root = await fixture(t);
  const producer = createConfiguredWikiProducer({
    createLead: () => ({
      async run(request) {
        await writeCandidate(request);
        await writeFile(path.join(root, "src", "index.ts"), "export const answer = 43;\n", "utf8");
        return { kind: "complete", summary: "stale" };
      },
    }),
  });
  const run = await producer.start({ cwd: root });
  await assert.rejects(run.result(), /sources changed during Wiki production/);
  await assert.rejects(readFile(path.join(root, "wiki", "runtime", "runtime.md"), "utf8"), { code: "ENOENT" });
});

test("resume rejects source drift before re-entering Lead and never mixes the candidate", async (t) => {
  const root = await fixture(t);
  let leadCalls = 0;
  const producer = createConfiguredWikiProducer({
    createLead: () => ({
      async run(request) {
        leadCalls += 1;
        await writeCandidate(request);
        return { kind: "pause", reason: "quota", summary: "wait" };
      },
    }),
  });
  const run = await producer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 43;\n", "utf8");
  await run.control("resume");
  await assert.rejects(run.result(), /sources changed while the Wiki run was paused/);
  assert.equal(leadCalls, 1);
  assert.equal(await readFile(path.join(root, ".okf-wiki", "runs", run.id, "candidate", "wiki", "runtime", "concepts", "runtime.md"), "utf8"), validPage());
  await assert.rejects(readFile(path.join(root, "wiki", "runtime", "concepts", "runtime.md"), "utf8"), { code: "ENOENT" });
});
