import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createConfiguredWikiProducer } from "../dist/production-run.js";
import { WikiLeadRun } from "../dist/wiki-lead-run.js";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-producer-v2-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function page(pageType, pagePath, title) {
  return { pageType, path: pagePath, title, purpose: "Runtime behavior", readerQuestions: [], requiredFacets: [], findingIds: [] };
}

function spec() {
  return {
    version: 1,
    overview: page("overview", "overview.md", "Overview"),
    domains: [{ id: "runtime", title: "Runtime", purpose: "Runtime behavior", pages: [
      page("domain", "runtime/domain.md", "Runtime domain"), page("concept", "runtime/lifecycle/concept.md", "Runtime"),
    ] }],
    crossLinks: [], sharedTerms: [], omissions: [],
  };
}

function content(type, title) {
  return ["---", `type: ${type}`, `title: ${title}`, "description: Runtime behavior", "sources:", "  - id: runtime", "    resource: repo:src/index.ts#L1-L1", "---", "", "Runtime behavior.[^runtime]", "", "[^runtime]: [Source](repo:src/index.ts#L1-L1)", ""].join("\n");
}

async function completeCandidate(request) {
  const lead = await WikiLeadRun.open({
    workspace: request.cwd, runId: request.runId, candidateWikiRoot: request.candidateWikiRoot,
    policy: request.generation, requiredSections: request.generation.templates.requiredSections,
    executionFence: { runStateFile: path.join(request.cwd, ".okf-wiki", "runs", request.runId, "run-state.json"), attempt: request.attempt, executionToken: request.executionToken },
  });
  await lead.saveSpec(spec());
  await lead.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" });
  await lead.replacePage({ path: "wiki/runtime/domain.md", content: content("Domain", "Runtime domain"), actor: "lead" });
  await lead.replacePage({ path: "wiki/runtime/lifecycle/concept.md", content: content("Concept", "Runtime"), actor: "lead" });
  await acceptReviews(lead, [
    ["wiki/overview.md"],
    ["wiki/runtime/domain.md"],
    ["wiki/runtime/lifecycle/concept.md"],
  ]);
}

async function acceptReviews(lead, groups) {
  for (let offset = 0; offset < groups.length; offset += 2) {
    const chunk = groups.slice(offset, offset + 2);
    const { batchId, contracts } = await lead.queueDelegateBatch(chunk.map((reviewPaths, index) => ({
      id: `review-${offset + index + 1}`, role: "review", instruction: "review", sourceScopeIds: [], contextRefs: [], reviewPaths,
    })));
    for (const contract of contracts) {
      await lead.taskTransitions.taskStarted(batchId, contract.id, { attempt: 1 });
      await lead.taskTransitions.taskSettled(batchId, contract.id, { attempt: 1, receipt: {
        id: contract.id, role: "review", status: "complete", summary: "pass", outputs: [], coverage: contract.reviewPaths, gaps: [], attempts: 1,
        contractId: contract.contractId, contractDigest: contract.contractDigest,
        review: { verdict: "pass", reviewedPaths: contract.reviewPaths, findings: [], profileCoverage: [] },
      } });
    }
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("updates replay every durable transition with its same-sequence view including terminal", async (t) => {
  const root = await workspace(t);
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await request.record({ kind: "progress", message: "Lead is working" });
    await completeCandidate(request);
    return { kind: "complete", summary: "done" };
  } }) });
  const handle = await producer.start({ cwd: root, focus: " runtime " });
  const result = await handle.result();
  assert.equal(result.summary, "done");
  assert.equal((await handle.view()).focus, "runtime");
  assert.equal((await handle.view()).operation, undefined);
  const updates = [];
  for await (const update of handle.updates()) updates.push(update);
  assert.equal(updates.at(-1).event.type, "completed");
  assert.equal(updates.at(-1).view.status, "succeeded");
  assert.equal(updates.at(-1).view.lastEventSequence, updates.at(-1).event.sequence);
  assert.deepEqual(updates.map(({ event }) => event.sequence), updates.map((_, index) => index + 1));
});

test("paused run serializes its workspace and resume reuses the exact pinned plan", async (t) => {
  const root = await workspace(t);
  const gate = deferred();
  let firstPlan;
  let calls = 0;
  const producer = createConfiguredWikiProducer({ createLead(plan) {
    if (!firstPlan) firstPlan = structuredClone(plan);
    else {
      const { leadSessionFile, leadSessionAttempt, ...base } = plan;
      assert.deepEqual(base, firstPlan);
      assert.equal(leadSessionFile, path.join(root, "lead-session.jsonl"));
      assert.equal(leadSessionAttempt, 1);
    }
    return { async run(request) {
      calls += 1;
      if (calls === 1) {
        await request.record({ kind: "telemetry", target: { kind: "lead" }, telemetry: {
          target: { kind: "lead" }, attempt: 1, sampledAt: "2026-01-01T00:00:00.000Z", activity: "streaming", activeTools: [],
          sessionFile: path.join(root, "lead-session.jsonl"),
        } });
        return { kind: "pause", reason: "quota", summary: "wait" };
      }
      await completeCandidate(request);
      await gate.promise;
      return { kind: "complete", summary: "resumed" };
    } };
  } });
  const first = await producer.start({ cwd: root });
  while ((await first.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(producer.start({ cwd: root }), /already active/);
  assert.equal((await first.control("resume")).status, "running");
  gate.resolve();
  assert.equal((await first.result()).summary, "resumed");
  assert.equal(calls, 2);
});

test("source drift after Lead completion fails without publishing the candidate", async (t) => {
  const root = await workspace(t);
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    await completeCandidate(request);
    await writeFile(path.join(root, "src", "index.ts"), "export const answer = 43;\n");
    return { kind: "complete", summary: "stale" };
  } }) });
  const handle = await producer.start({ cwd: root });
  await assert.rejects(handle.result(), /sources changed while the Wiki run was active/);
  await assert.rejects(readFile(path.join(root, "wiki", "overview.md"), "utf8"), { code: "ENOENT" });
  assert.equal((await handle.view()).status, "failed");
});

test("same deterministic run id in two workspaces keeps executions and update hubs isolated", async (t) => {
  const left = await workspace(t);
  const right = await workspace(t);
  const seen = [];
  const producer = createConfiguredWikiProducer({
    createId: () => "same-run",
    createLead: () => ({ async run(request) {
      seen.push(request.cwd);
      return { kind: "pause", reason: "quota", summary: `paused:${request.cwd}` };
    } }),
  });
  const [leftRun, rightRun] = await Promise.all([producer.start({ cwd: left }), producer.start({ cwd: right })]);
  while ((await leftRun.view()).status === "running" || (await rightRun.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(leftRun.id, "same-run");
  assert.equal(rightRun.id, "same-run");
  assert.deepEqual(new Set(seen), new Set([left, right]));
  const leftUpdates = [];
  for await (const update of leftRun.updates()) { leftUpdates.push(update); if (update.event.type === "paused") break; }
  assert.ok(leftUpdates.every((update) => update.view.cwd === left));
});

test("resume requested while an abort-ignoring attempt settles is deferred and eventually launches", async (t) => {
  const root = await workspace(t);
  const release = deferred();
  let calls = 0;
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run() {
    calls += 1;
    if (calls === 1) await release.promise;
    return { kind: "pause", reason: "quota", summary: `attempt ${calls}` };
  } }) });
  const run = await producer.start({ cwd: root });
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await run.control("pause")).status, "paused");
  assert.equal((await run.control("resume")).status, "running");
  release.resolve();
  while (calls < 2 || (await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal((await run.view()).status, "paused");
});

test("cancel fences observations from a slow prior attempt", async (t) => {
  const root = await workspace(t);
  const entered = deferred();
  const release = deferred();
  const attempted = deferred();
  let lateError;
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    entered.resolve();
    await release.promise;
    try { await request.record({ kind: "progress", message: "late write" }); } catch (error) { lateError = error; }
    finally { attempted.resolve(); }
    return { kind: "complete", summary: "too late" };
  } }) });
  const run = await producer.start({ cwd: root });
  await entered.promise;
  const cancelled = await run.control("cancel");
  const sequence = cancelled.lastEventSequence;
  release.resolve();
  await attempted.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await run.view()).status, "cancelled");
  assert.equal((await run.view()).lastEventSequence, sequence);
  assert.match(String(lateError), /no longer current/);
});

test("cancel fences direct Candidate mutations from an abort-ignoring Lead", async (t) => {
  const root = await workspace(t);
  const ready = deferred();
  const release = deferred();
  const attempted = deferred();
  let lateError;
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run(request) {
    const lead = await WikiLeadRun.open({
      workspace: request.cwd, runId: request.runId, candidateWikiRoot: request.candidateWikiRoot,
      policy: request.generation, requiredSections: request.generation.templates.requiredSections,
      executionFence: { runStateFile: path.join(request.cwd, ".okf-wiki", "runs", request.runId, "run-state.json"), attempt: request.attempt, executionToken: request.executionToken },
    });
    await lead.saveSpec(spec());
    ready.resolve();
    await release.promise;
    try { await lead.replacePage({ path: "wiki/overview.md", content: content("Overview", "Overview"), actor: "lead" }); }
    catch (error) { lateError = error; }
    finally { attempted.resolve(); }
    return { kind: "complete", summary: "too late" };
  } }) });
  const run = await producer.start({ cwd: root });
  await ready.promise;
  await run.control("cancel");
  release.resolve();
  await attempted.promise;
  assert.match(String(lateError), /no longer.*active|execution fence/i);
  await assert.rejects(readFile(path.join(root, ".okf-wiki", "runs", run.id, "candidate", "wiki", "overview.md"), "utf8"), { code: "ENOENT" });
});

test("a second producer attaches to the live process run and concurrent controls serialize durably", async (t) => {
  const root = await workspace(t);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const firstProducer = createConfiguredWikiProducer({ createId: () => "shared-run", createLead: () => ({ async run() {
    calls += 1;
    if (calls === 1) { entered.resolve(); await release.promise; }
    return { kind: "pause", reason: "quota", summary: `attempt:${calls}` };
  } }) });
  const first = await firstProducer.start({ cwd: root });
  await entered.promise;
  const before = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", first.id, "run-state.json"), "utf8"));
  const secondProducer = createConfiguredWikiProducer({ createLead: () => { throw new Error("must attach to existing run"); } });
  const second = await secondProducer.open(first.id, path.join(root, "src"));
  assert.ok(second);
  const controls = await Promise.allSettled([first.control("pause"), second.control("pause")]);
  assert.equal(controls.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await second.view()).status, "paused");
  const resumed = await second.control("resume");
  const after = JSON.parse(await readFile(path.join(root, ".okf-wiki", "runs", first.id, "run-state.json"), "utf8"));
  assert.equal(resumed.status, "running");
  assert.equal(after.attempt, before.attempt + 1);
  assert.notEqual(after.executionToken, before.executionToken);
  release.resolve();
  while (calls < 2 || (await second.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
});

test("open and resume use pinned paths even when workspace config becomes invalid", async (t) => {
  const root = await workspace(t);
  let calls = 0;
  const firstProducer = createConfiguredWikiProducer({ createId: () => "pinned-open", createLead: () => ({ async run() {
    calls += 1;
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const run = await firstProducer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(root, "workspace.yaml"), "not: [valid\n");
  const secondProducer = createConfiguredWikiProducer({});
  const reopened = await secondProducer.open(run.id, path.join(root, "src"));
  assert.ok(reopened);
  await reopened.control("resume");
  while ((await reopened.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal((await reopened.view()).status, "paused");
});

test("resume rejects a modified materialized production skill", async (t) => {
  const root = await workspace(t);
  const producer = createConfiguredWikiProducer({ createLead: () => ({ async run() {
    return { kind: "pause", reason: "quota", summary: "wait" };
  } }) });
  const run = await producer.start({ cwd: root });
  while ((await run.view()).status === "running") await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(path.join(root, ".okf-wiki", "runs", run.id, "skill", "references", "common.md"), "changed\n");
  await run.control("resume");
  await assert.rejects(run.result(), /production skill changed/);
  assert.equal((await run.view()).status, "failed");
});
