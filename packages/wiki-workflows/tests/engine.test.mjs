import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiArtifactStore } from "../dist/artifact-store.js";
import { WikiWorkflowEngine } from "../dist/engine.js";
import { WikiAgentContextBudgetError, WikiAgentProtocolError } from "../dist/agent-errors.js";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function findingId(scopeId, kind = "domain", evidence) {
  const source = scopeId.replace(/^source-survey:/, "");
  return `finding-${createHash("sha256").update(stableStringify({
    scopeId,
    kind,
    evidence: evidence ?? [`${source}/index.ts#L1`],
  })).digest("hex").slice(0, 16)}`;
}

function page(domain, name, source, pageType = "module") {
  const scopeId = source.startsWith("source-survey:") ? source : `source-survey:${source}`;
  return {
    pageType,
    path: `${domain}/${name}.md`,
    title: `${domain} ${name}`,
    purpose: `Explain ${domain} ${name}`,
    readerQuestions: [`How does ${domain} ${name} work?`],
    requiredFacets: ["responsibilities", "boundaries", "evidence"],
    findingIds: [findingId(scopeId)],
  };
}

function spec(contentPages = [
  page("core", "architecture", "source-survey:src-core", "architecture"),
  page("api", "request-flow", "source-survey:src-api", "flow"),
]) {
  const byDomain = new Map();
  for (const item of contentPages) {
    const id = item.path.split("/", 1)[0];
    const domain = byDomain.get(id) ?? { id, title: id, purpose: `Explain ${id}`, pages: [] };
    domain.pages.push(item);
    byDomain.set(id, domain);
  }
  for (const domain of byDomain.values()) {
    const findingIds = [...new Set(domain.pages.flatMap((item) => item.findingIds))];
    domain.pages.unshift({
      pageType: "domain",
      path: `${domain.id}/domain.md`,
      title: `${domain.title} domain`,
      purpose: `Aggregate the ${domain.title} models, flows, state, invariants, and boundaries`,
      readerQuestions: [`How do the ${domain.title} domain's models and flows fit together?`],
      requiredFacets: ["models", "flows", "state", "invariants", "boundaries"],
      findingIds,
    });
  }
  return {
    domains: [
      {
        id: "overview",
        title: "Overview",
        purpose: "Orient readers",
        pages: [{
          pageType: "overview",
          path: "overview/overview.md",
          title: "System Overview",
          purpose: "Orient readers across all pages",
          readerQuestions: ["What are the system's main domains?"],
          requiredFacets: ["domain map", "entry points", "cross-domain flow"],
          findingIds: [],
        }],
      },
      ...byDomain.values(),
    ],
    crossLinks: contentPages.length > 1
      ? [{ fromPath: contentPages[0].path, toPath: contentPages[1].path, purpose: "Connect related behavior" }]
      : [],
    sharedTerms: [{ term: "request", definition: "One invocation" }],
    omissions: [],
  };
}

function inspection(workspace, options = {}) {
  return {
    root: workspace,
    wikiRoot: path.join(workspace, "wiki"),
    sourcePaths: options.sourcePaths ?? ["src-core", "src-api"],
    mode: options.mode ?? "refresh",
    head: options.head ?? "head",
    baseCommit: "base",
    lastWikiCommit: "base",
    changed: [],
    changedPaths: [],
    sourceFingerprint: options.sourceFingerprint ?? "source-1",
    existingPages: options.existingPages ?? [],
    impactedPages: options.impactedPages ?? [],
    wikiDrift: false,
    refreshRequiresGenerateReason: options.refreshRequiresGenerateReason,
  };
}

function validation(value = {}) {
  return {
    ok: value.ok ?? true,
    issues: value.issues ?? [],
    pages: value.pages ?? ["overview/overview.md", "core/architecture.md", "api/request-flow.md"],
    obsoletePages: value.obsoletePages ?? [],
  };
}

function concurrentArtifactStore(base, barrierKinds) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const synthetic = new Map();
  return {
    ...base,
    async write(input) {
      if (!barrierKinds.has(input.kind) || arrivals >= 2) return await base.write(input);
      arrivals += 1;
      if (arrivals === 2) release();
      await ready;
      const bytes = Buffer.from(input.content, "utf8");
      const ref = {
        version: 1,
        runId: input.runId,
        nodeId: input.nodeId,
        attempt: input.attempt,
        kind: input.kind,
        relativePath: `.barrier/${input.runId}/${input.nodeId}/${input.kind}.json`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
        mediaType: "application/json",
      };
      synthetic.set(ref.relativePath, input.content);
      return ref;
    },
    async read(ref) {
      return synthetic.has(ref.relativePath) ? synthetic.get(ref.relativePath) : await base.read(ref);
    },
    resolve(ref) {
      return synthetic.has(ref.relativePath) ? ref.relativePath : base.resolve(ref);
    },
  };
}

async function fixture(t, options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-engine-v6-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const configuredSources = options.inspectionSequence?.[0]?.sourcePaths
    ?? options.inspection?.sourcePaths
    ?? ["src-core", "src-api"];
  await Promise.all(configuredSources.map(async (root) => {
    await mkdir(path.join(workspace, root), { recursive: true });
    await writeFile(path.join(workspace, root, "index.ts"), `export const source = "${root}";\n`, "utf8");
  }));
  const requests = [];
  const writes = [];
  let synthesisCalls = 0;
  let reviewCalls = 0;
  let writerCalls = 0;
  let activeWriters = 0;
  let maxActiveWriters = 0;
  const runtimePolicies = [];
  const executor = {
    setRuntimePolicy(policy) {
      runtimePolicies.push(structuredClone(policy));
    },
    async execute(request) {
      requests.push(request);
      if (request.node.kind === "research") {
        if (options.onResearch) return await options.onResearch(request);
        // Initial surveys mint scope-bound findings. Audits/supplemental default to
        // no new findings so re-statements do not invent fresh finding ids.
        const findings = request.node.input.batch === 0
          ? request.node.input.scope.sourcePaths.map((source) => ({
            kind: "domain",
            title: `${source} responsibilities`,
            readerQuestion: `What does ${source} own?`,
            priority: "critical",
            evidence: [`${source}/index.ts#L1`],
          }))
          : [];
        return {
          result: {
            summary: `Covered ${request.node.input.scope.sourcePaths.join(", ")}`,
            findings,
            gaps: [],
          },
        };
      }
      if (request.node.kind === "synthesis") {
        const result = options.synthesis?.(request, synthesisCalls++) ?? {
          decision: "finalize",
          spec: options.spec ?? spec(),
          rationale: "Evidence is sufficient.",
        };
        return { result };
      }
      if (request.node.kind === "write") {
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        const index = writerCalls++;
        try {
          if (options.writeDelay) await new Promise((resolve) => setTimeout(resolve, options.writeDelay));
          const handled = await options.onWrite?.(request, index, workspace);
          if (!handled) {
            for (const output of request.writePaths ?? []) {
              const absolute = path.join(request.candidateWikiRoot, output.replace(/^wiki\//, ""));
              await mkdir(path.dirname(absolute), { recursive: true });
              await writeFile(absolute, `---\ntype: ${request.node.input.page.pageType}\ntitle: page\ndescription: page\ntags: [test]\nsources: [{ id: source, resource: "repo:src-core/index.ts#L1" }]\n---\n\nwrite-${index}[^source]\n\n[^source]: [source](repo:src-core/index.ts#L1)\n`, "utf8");
            }
          }
          writes.push({ request, index });
          const submitted = await request.validatePageSubmission(request.node.input.page.path);
          assert.equal(submitted.ok, true);
          return { result: submitted.submission };
        } finally {
          activeWriters -= 1;
        }
      }
      if (request.node.kind === "review") {
        return { result: await options.review?.(request, reviewCalls++) ?? { defects: [], summary: "complete" } };
      }
      throw new Error(`Unexpected agent node: ${request.node.kind}`);
    },
  };
  const inspections = (options.inspectionSequence ?? [options.inspection ?? {}]).map((item) => inspection(workspace, item));
  let inspectCalls = 0;
  let validationCalls = 0;
  let finalizationCalls = 0;
  let id = 0;
  const baseArtifactStore = createWikiArtifactStore({ workspace, rootDir: path.join(workspace, ".artifacts") });
  const engine = new WikiWorkflowEngine({
    executor,
    inspect: async () => structuredClone(inspections[Math.min(inspectCalls++, inspections.length - 1)]),
    validate: async (_cwd, targetSpec) => options.validate?.(targetSpec, validationCalls++) ?? validation(),
    validatePage: async () => [],
    materializeIndexes: async () => ["index.md"],
    finalize: async (_cwd, targetSpec) => {
      finalizationCalls += 1;
      return options.finalize?.(targetSpec, finalizationCalls - 1) ?? {
        pages: targetSpec.domains.flatMap((domain) => domain.pages.map((item) => item.path)),
        obsoletePages: [],
        removedPages: [],
        rebuiltIndexes: ["index.md"],
      };
    },
    artifactStore: options.concurrentArtifactKinds
      ? concurrentArtifactStore(baseArtifactStore, new Set(options.concurrentArtifactKinds))
      : baseArtifactStore,
    createId: () => `id-${++id}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  return { engine, executor, requests, writes, runtimePolicies, workspace, get maxActiveWriters() { return maxActiveWriters; }, get finalizationCalls() { return finalizationCalls; } };
}

test("restore rejects a structurally corrupt current snapshot", () => {
  const engine = new WikiWorkflowEngine({ executor: { execute: async () => ({ result: undefined }) } });
  const malformed = {
    version: 1,
    id: "malformed",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "running",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: 6,
    nodes: [null],
    events: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };

  assert.equal(engine.restore(malformed), undefined);
});

test("restore rejects a current snapshot below the research saturation minimum", () => {
  const engine = new WikiWorkflowEngine({ executor: { execute: async () => ({ result: undefined }) } });
  const snapshot = {
    version: 1,
    id: "undersized-budget",
    cwd: "/workspace",
    requestedMode: "generate",
    language: "zh",
    status: "paused",
    round: 0,
    sourceRestartCount: 0,
    maxResearchRounds: 2,
    nodes: [],
    events: [],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };

  assert.equal(engine.restore(snapshot), undefined);
});

test("interrupt is idempotent before any Wiki run starts", async () => {
  const engine = new WikiWorkflowEngine({ executor: { execute: async () => ({ result: undefined }) } });
  assert.equal(await engine.interrupt(), undefined);
});

test("execution failure publishes terminal snapshots and a run_failed event", async () => {
  let id = 0;
  const observed = [];
  const engine = new WikiWorkflowEngine({
    executor: { execute: async () => ({ result: undefined }) },
    inspect: async () => { throw new Error("inspection unavailable"); },
    createId: () => `failure-${++id}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  engine.subscribe((value, event) => observed.push({ value, event }));

  engine.start({ cwd: "/workspace", mode: "generate" });
  const failed = await engine.waitForIdle();

  assert.equal(failed.status, "failed");
  assert.equal(failed.completedAt, "2026-08-10T00:00:00.000Z");
  const nodeFailure = observed.find(({ event }) => event.kind === "node_failed");
  assert.equal(nodeFailure.value.status, "failed", "node failure persistence must already contain the terminal run status");
  assert.equal(nodeFailure.value.completedAt, "2026-08-10T00:00:00.000Z");
  assert.equal(observed.at(-1).event.kind, "run_failed");
});

test("parallel failure aborts sibling agents before publishing one terminal event", async (t) => {
  let siblingAborted = false;
  const f = await fixture(t, {
    onResearch: async (request) => {
      if (request.node.input.scope.id.includes("src-core")) throw new Error("primary research failed");
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          siblingAborted = true;
          reject(new Error("sibling research aborted"));
        };
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const observed = [];
  f.engine.subscribe((value, event) => observed.push({ value, event }));

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const failed = await f.engine.waitForIdle();

  assert.equal(failed.status, "failed");
  assert.equal(siblingAborted, true);
  assert.deepEqual(
    failed.nodes.filter((node) => node.kind === "research").map((node) => node.status).sort(),
    ["cancelled", "failed"],
  );
  assert.equal(failed.nodes.some((node) => node.status === "running"), false);
  assert.equal(observed.filter(({ event }) => event.kind === "run_failed").length, 1);
  assert.equal(observed.at(-1).event.kind, "run_failed");
  assert.equal(observed.at(-1).value.nodes.some((node) => node.status === "running"), false);
});

test("research evidence must resolve to an existing file and line range", async (t) => {
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    onResearch: async () => ({
      result: {
        summary: "invalid evidence",
        findings: [{
          kind: "concept",
          title: "Missing",
          readerQuestion: "What exists?",
          priority: "critical",
          evidence: ["src-core/index.ts#L99"],
        }],
        gaps: [],
      },
    }),
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.match(
    snapshot.nodes.find((node) => node.kind === "research").error.message,
    /line range exceeds file|missing|does not name a file|outside the assigned scope/,
  );
});

test("concurrent research completion reconciles the batch after all statuses settle", async (t) => {
  const f = await fixture(t, { concurrentArtifactKinds: ["research"] });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research" && node.input.batch === 0).length, 2);
  assert.ok(snapshot.nodes.some((node) => node.kind === "synthesis"));
  assert.equal(f.finalizationCalls, 1);
});

test("an active agent failure while scheduling is paused makes the run failed", async (t) => {
  let rejectResearch;
  let researchStarted;
  const started = new Promise((resolve) => { researchStarted = resolve; });
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    onResearch: async () => await new Promise((_resolve, reject) => {
      rejectResearch = reject;
      researchStarted();
    }),
  });
  const eventKinds = [];
  f.engine.subscribe((_value, event) => eventKinds.push(event.kind));

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  await started;
  f.engine.pause();
  rejectResearch(new Error("research failed while paused"));
  const failed = await f.engine.waitForIdle();

  assert.equal(failed.status, "failed");
  assert.equal(failed.nodes.find((node) => node.kind === "research").status, "failed");
  assert.equal(eventKinds.at(-1), "run_failed");
});

test("pause leaves running agents; stop aborts and requeues; cancel is terminal", async (t) => {
  let researchStarted;
  const started = new Promise((resolve) => { researchStarted = resolve; });
  let aborted = false;
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    onResearch: async (request) => await new Promise((resolve, reject) => {
      researchStarted();
      const onAbort = () => {
        aborted = true;
        reject(new Error("research aborted"));
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  const events = [];
  f.engine.subscribe((_value, event) => events.push(event));

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  await started;

  // Soft pause: status paused, running node stays running, no abort.
  const paused = f.engine.pause();
  assert.equal(paused.status, "paused");
  const researchWhilePaused = paused.nodes.find((node) => node.kind === "research");
  assert.equal(researchWhilePaused.status, "running");
  assert.equal(aborted, false);
  assert.ok(events.some((event) => event.kind === "run_paused" && /active agents may finish/i.test(event.message ?? "")));

  // Hard stop: abort + requeue running as queued; still paused/resumable.
  const stopped = await f.engine.stop();
  assert.equal(stopped.status, "paused");
  const researchAfterStop = stopped.nodes.find((node) => node.kind === "research");
  assert.equal(researchAfterStop.status, "queued");
  assert.match(researchAfterStop.activity.message, /Stopped|resume/i);
  assert.equal(aborted, true);
  assert.ok(events.some((event) => event.kind === "run_paused" && /stopped.*resume/i.test(event.message ?? "")));
  assert.equal(stopped.completedAt, undefined);
  assert.equal(f.engine.isNodeLive(researchAfterStop.id), false);

  // Cancel from paused is terminal and not resumable.
  const cancelled = await f.engine.cancel();
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.completedAt);
  assert.ok(cancelled.nodes.every((node) => node.status !== "running" && node.status !== "queued"));
  assert.ok(events.some((event) => event.kind === "run_cancelled"));
});

test("interrupt reuses hard-stop-resume semantics", async (t) => {
  let researchStarted;
  const started = new Promise((resolve) => { researchStarted = resolve; });
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    onResearch: async (request) => await new Promise((resolve, reject) => {
      researchStarted();
      const onAbort = () => reject(new Error("aborted"));
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  const events = [];
  f.engine.subscribe((_value, event) => events.push(event));

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  await started;
  const interrupted = await f.engine.interrupt();

  assert.equal(interrupted.status, "paused");
  assert.equal(interrupted.nodes.find((node) => node.kind === "research").status, "queued");
  assert.ok(events.some((event) => event.kind === "run_paused" && /session shutdown/i.test(event.message ?? "")));
});

test("generate fans out domain and detail writers within the configured concurrency and gates Overview", async (t) => {
  const pages = Array.from({ length: 6 }, (_, index) => page(`d${index}`, "page", index % 2 ? "source-survey:src-api" : "source-survey:src-core"));
  const f = await fixture(t, { spec: spec(pages), writeDelay: 8 });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.maxResearchRounds, 6);
  assert.equal(snapshot.sourceRestartCount, 0);
  assert.equal(f.requests.filter((request) => request.node.kind === "research").length, 2, "source surveys only; no forced dry audit without critical gaps");
  assert.equal(f.requests.filter((request) => request.node.kind === "write").length, 13);
  assert.equal(f.maxActiveWriters, 2);
  const overview = snapshot.nodes.find((node) => node.kind === "write" && node.input.intent === "overview");
  const content = snapshot.nodes.filter((node) => node.kind === "write" && node.input.intent === "draft");
  assert.deepEqual(new Set(overview.dependsOn), new Set(content.map((node) => node.id)));
  assert.ok(content.every((node) => node.input.writePaths.length === 1));
  assert.ok(snapshot.nodes.every((node) => ["inspect", "research", "plan", "write", "review"].includes(node.phaseId)));
  assert.equal(snapshot.nodes.at(-1).kind, "finalize");
  assert.equal(f.finalizationCalls, 1);

  const coreWriter = f.requests.find((request) => request.node.kind === "write" && request.node.input.page.path === "d0/page.md");
  assert.deepEqual(coreWriter.readRoots, ["src-core"]);
  assert.equal(coreWriter.artifactPaths.length, 1);
  assert.match(coreWriter.artifactPaths[0], /^\.okf-wiki\/blobs\/[a-f0-9]{64}\.json$/);
  assert.match(coreWriter.prompt, /"scopeId": "source-survey:src-core"/);
  assert.match(coreWriter.prompt, new RegExp(coreWriter.artifactPaths[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(coreWriter.prompt, /"outgoingCrossLinks"/);
  assert.match(coreWriter.prompt, /"href": "\.\.\/d1\/page.md"/);
  assert.match(coreWriter.prompt, /"incomingCrossLinks"/);
  assert.doesNotMatch(coreWriter.prompt, /JSON synthesis decision|Review summary/);
  const researcher = f.requests.find((request) => request.node.kind === "research"
    && request.node.input.scope.id === "source-survey:src-core");
  assert.match(researcher.prompt, /"id": "source-survey:src-core"/);
  assert.doesNotMatch(researcher.prompt, /researchGroupId|priorResearchIds|priorSynthesisNodeId|structuralRoundId/);
  const overviewRequest = f.requests.find((request) => request.node.kind === "write" && request.node.input.intent === "overview");
  assert.deepEqual(overviewRequest.readRoots, ["src-core", "src-api"]);
  assert.equal(overviewRequest.artifactPaths, undefined);
  assert.equal(overviewRequest.wikiReadPaths.length, 12);
  const reviewer = f.requests.find((request) => request.node.kind === "review");
  assert.equal(reviewer.artifactPaths, undefined);
  assert.match(reviewer.prompt, /"path": "d0\/page.md"/);
  assert.doesNotMatch(reviewer.prompt, /verificationGroupId|synthesisNodeId/);
});

test("the minimum research budget completes the initial survey without a forced dry audit", async (t) => {
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    spec: spec([page("core", "architecture", "source-survey:src-core", "architecture")]),
  });

  f.engine.start({ cwd: f.workspace, mode: "generate", maxResearchRounds: 3 });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(snapshot.maxResearchRounds, 3);
  // Happy path: no critical gaps → surveys only, no dry-coverage audit batch.
  assert.deepEqual(
    snapshot.nodes.filter((node) => node.kind === "research").map((node) => node.input.batch),
    [0],
  );
  assert.equal(
    snapshot.nodes.filter((node) => node.kind === "research" && node.input.continuationMode === "audit").length,
    0,
  );
});

test("pinned workspace policy reaches research, planning, writing, review, and concurrency", async (t) => {
  const pages = Array.from({ length: 4 }, (_, index) => page("core", `page-${index}`, "source-survey:src-core"));
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    spec: spec(pages),
    writeDelay: 8,
  });
  f.engine.start({
    cwd: f.workspace,
    mode: "generate",
    wikiPolicy: {
      exclude: ["src-core/generated/**"],
      terminology: { Ledger: "Canonical accounting record" },
      domains: [],
      quality: { maxSubmissionAttempts: 1 },
      runtime: { maxConcurrentAgents: 3, nodeTimeoutSeconds: 60, maxAutoRetries: 16, maxTransientSessionAttempts: 1, rateLimitCooldownSeconds: 120 },
    },
  });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(f.maxActiveWriters, 3);
  assert.deepEqual(f.runtimePolicies[0], snapshot.policy);
  for (const kind of ["research", "synthesis", "write", "review"]) {
    const request = f.requests.find((candidate) => candidate.node.kind === kind);
    assert.equal(request.maxSubmissionAttempts, 1);
    assert.match(request.prompt, /Canonical accounting record/);
    assert.match(request.prompt, /src-core\/generated\/\*\*/);
  }
});

test("policy stays pinned until resume reconciliation and new runs use the latest workspace values", async () => {
  const appliedPolicies = [];
  let id = 0;
  const engine = new WikiWorkflowEngine({
    executor: {
      async execute() { return { result: undefined }; },
      setRuntimePolicy(policy) { appliedPolicies.push(structuredClone(policy)); },
    },
    inspect: async () => await new Promise(() => {}),
    createId: () => `policy-${++id}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  const initialWorkspacePolicy = {
    exclude: ["generated/**"],
    terminology: { Ledger: "Original definition" },
    domains: [],
    quality: { maxSubmissionAttempts: 2 },
    runtime: {
      maxConcurrentAgents: 1,
      nodeTimeoutSeconds: 600,
      maxAutoRetries: 3,
      maxTransientSessionAttempts: 1,
      rateLimitCooldownSeconds: 30,
    },
  };
  engine.start({ cwd: "/workspace", mode: "generate", wikiPolicy: initialWorkspacePolicy });

  const runningPolicy = {
    ...initialWorkspacePolicy,
    runtime: { ...initialWorkspacePolicy.runtime, maxConcurrentAgents: 4 },
  };
  assert.throws(
    () => engine.reconcilePolicy(runningPolicy),
    /only be reconciled while the run is paused or blocked/,
  );
  assert.equal(engine.getSnapshot().policy.runtime.maxConcurrentAgents, 1);
  assert.equal(appliedPolicies.at(-1).runtime.maxConcurrentAgents, 1);
  engine.pause();

  initialWorkspacePolicy.terminology.Ledger = "Mutated after start";
  initialWorkspacePolicy.runtime.maxConcurrentAgents = 4;
  const pinned = engine.getSnapshot();
  assert.equal(pinned.policy.terminology.Ledger, "Original definition");
  assert.equal(pinned.policy.runtime.maxConcurrentAgents, 1);

  const latestWorkspacePolicy = {
    ...initialWorkspacePolicy,
    terminology: { Ledger: "Latest definition" },
    runtime: { ...initialWorkspacePolicy.runtime, nodeTimeoutSeconds: 900 },
  };
  assert.equal(engine.reconcilePolicy(latestWorkspacePolicy), true);
  const reconciled = engine.getSnapshot();
  assert.equal(reconciled.policy.terminology.Ledger, "Latest definition");
  assert.equal(reconciled.policy.runtime.maxConcurrentAgents, 4);
  assert.equal(reconciled.inspection, undefined);
  assert.equal(reconciled.effectiveMode, undefined);
  assert.equal(reconciled.nodes[0].kind, "inspect");
  assert.equal(reconciled.nodes[0].input.policyHash, reconciled.policyHash);
  assert.ok(reconciled.events.some((event) => event.kind === "recovered" && /policy changed/.test(event.message)));
  assert.equal(engine.reconcilePolicy(latestWorkspacePolicy), false);

  const restorable = await engine.cancel();
  const restoredPolicies = [];
  const restoredEngine = new WikiWorkflowEngine({
    executor: {
      async execute() { return { result: undefined }; },
      setRuntimePolicy(policy) { restoredPolicies.push(structuredClone(policy)); },
    },
  });
  assert.equal(restoredEngine.restore(restorable).policyHash, restorable.policyHash);
  assert.deepEqual(restoredPolicies, [restorable.policy]);

  const next = engine.start({ cwd: "/workspace", mode: "generate", wikiPolicy: latestWorkspacePolicy });
  engine.pause();
  assert.equal(next.policy.terminology.Ledger, "Latest definition");
  assert.equal(next.policy.runtime.nodeTimeoutSeconds, 900);
  assert.equal(appliedPolicies.at(-1).runtime.maxConcurrentAgents, 4);
  await engine.cancel();
});

test("research budgets below the saturation minimum are rejected", async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => f.engine.start({ cwd: f.workspace, mode: "generate", maxResearchRounds: 2 }),
    /integer from 3 to 20/,
  );
});

test("more than four repositories and fifteen pages are all scheduled without a page quota", async (t) => {
  const sources = Array.from({ length: 6 }, (_, index) => `repo-${index}`);
  const pages = sources.flatMap((source, sourceIndex) => Array.from({ length: 3 }, (_, pageIndex) =>
    page(`domain-${sourceIndex}`, `page-${pageIndex}`, `source-survey:${source}`, "concept")));
  const f = await fixture(t, { inspection: { sourcePaths: sources }, spec: spec(pages), writeDelay: 2 });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research" && node.input.batch === 0).length, 6);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "write" && node.input.intent === "draft").length, 24);
  assert.equal(f.maxActiveWriters, 2);
});

test("Write validation repairs before semantic review and keeps feedback attributable", async (t) => {
  const f = await fixture(t, {
    validate: async (_spec, index) => {
      if (index > 0) return validation();
      return validation({ ok: false, issues: [{ code: "frontmatter", page: "core/architecture.md", message: "Fix metadata" }] });
    },
    review: async (_request, index) => {
      if (index > 0) return { defects: [], summary: "complete" };
      return { defects: [{ kind: "depth", page: "core/architecture.md", detail: "Explain failure behavior" }], summary: "repair" };
    },
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  const repairs = snapshot.nodes.filter((node) => node.kind === "write"
    && node.input.intent === "repair" && node.input.page.path === "core/architecture.md");
  assert.equal(repairs.length, 2);
  assert.equal(repairs[0].input.feedback.validation.issues.length, 1);
  assert.equal(repairs[1].input.feedback.review.defects.length, 1);
  const firstReview = snapshot.nodes.find((node) => node.kind === "review");
  const cleanValidation = snapshot.nodes.filter((node) => node.kind === "validate").at(1);
  assert.deepEqual(firstReview.dependsOn, [cleanValidation.id]);
});

test("a new critical audit finding resets the dry coverage saturation counter", async (t) => {
  let flowFindingId;
  let emittedNewCritical = false;
  // Force the coverage-audit path: surveys keep unresolved critical gaps so
  // finalize→afterSuccess queues audits (submit-time would normally expand instead).
  const f = await fixture(t, {
    onResearch: async (request) => {
      const batch = request.node.input.batch;
      if (batch === 0) {
        return {
          result: {
            summary: "coverage with open gaps",
            findings: request.node.input.scope.sourcePaths.map((source) => ({
              kind: "domain",
              title: `${source} responsibilities`,
              readerQuestion: `What does ${source} own?`,
              priority: "critical",
              evidence: [`${source}/index.ts#L1`],
            })),
            gaps: [{
              priority: "critical",
              question: "What is the request failure path?",
              sourcePaths: request.node.input.scope.sourcePaths,
            }],
          },
        };
      }
      // First audit only: one novel critical finding (scope-bound id). Later audits are dry.
      if (!emittedNewCritical) {
        emittedNewCritical = true;
        const scopeId = request.node.input.scope.id;
        flowFindingId = findingId(scopeId, "flow", ["src-core/extra.ts#L1"]);
        return {
          result: {
            summary: "new critical flow",
            findings: [{
              kind: "flow",
              title: "Critical request flow",
              readerQuestion: "How does the request flow?",
              priority: "critical",
              evidence: ["src-core/extra.ts#L1"],
            }],
            gaps: [],
          },
        };
      }
      return { result: { summary: "dry audit", findings: [], gaps: [] } };
    },
    synthesis: () => {
      const target = spec();
      if (flowFindingId) {
        target.domains[1].pages[0].findingIds.push(flowFindingId);
      }
      return { decision: "finalize", spec: target, rationale: "covered" };
    },
  });
  await writeFile(path.join(f.workspace, "src-core", "extra.ts"), "export const flow = true;\n", "utf8");

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  // One non-dry audit (new critical) then one dry audit satisfies requiredDryCoverageAudits=1.
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research" && node.input.continuationMode === "audit").length, 2);
  const auditSyntheses = snapshot.nodes.filter((node) => node.kind === "synthesis" && node.input.mode === "audit");
  assert.deepEqual(auditSyntheses.map((node) => node.input.dryAuditPasses), [0, 1]);
});

test("writer validator infrastructure failures retry the node automatically", async (t) => {
  let failedOnce = false;
  const f = await fixture(t, {
    onWrite: async () => {
      if (failedOnce) return false;
      failedOnce = true;
      throw new WikiAgentProtocolError(["wiki_submit_page"], "", [], {
        code: "validator_infrastructure",
        message: "validator unavailable",
      });
    },
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "write").some((node) => node.attempt === 2), true);
});

test("context budget exceeded requeues the research node and keeps the run running until success", async (t) => {
  let researchCalls = 0;
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    spec: spec([page("core", "architecture", "source-survey:src-core", "architecture")]),
    onResearch: async (request) => {
      researchCalls += 1;
      if (researchCalls === 1) {
        throw new WikiAgentContextBudgetError("partial output", [], "context overflow recovery failed");
      }
      const findings = request.node.input.batch === 0
        ? request.node.input.scope.sourcePaths.map((source) => ({
          kind: "domain",
          title: `${source} responsibilities`,
          readerQuestion: `What does ${source} own?`,
          priority: "critical",
          evidence: [`${source}/index.ts#L1`],
        }))
        : [];
      return {
        result: {
          summary: `Covered ${request.node.input.scope.sourcePaths.join(", ")}`,
          findings,
          gaps: [],
        },
      };
    },
  });
  const eventKinds = [];
  f.engine.subscribe((_value, event) => eventKinds.push(event.kind));

  f.engine.start({ cwd: f.workspace, mode: "generate", maxResearchRounds: 3 });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.ok(eventKinds.includes("node_retried"), "first context-budget failure must requeue via node_retried");
  const research = snapshot.nodes.find((node) => node.kind === "research" && node.input.batch === 0);
  assert.equal(research.status, "succeeded");
  assert.equal(research.attempt, 2);
  assert.ok(researchCalls >= 2, "executor must be invoked again after requeue");
});

test("context budget exceeded blocks the node and run after max attempts (not failed)", async (t) => {
  let researchCalls = 0;
  const f = await fixture(t, {
    inspection: { sourcePaths: ["src-core"] },
    onResearch: async () => {
      researchCalls += 1;
      throw new WikiAgentContextBudgetError("partial output", [], "context window exhausted");
    },
  });

  f.engine.start({ cwd: f.workspace, mode: "generate", maxResearchRounds: 3 });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "blocked");
  assert.notEqual(snapshot.status, "failed");
  const research = snapshot.nodes.find((node) => node.kind === "research");
  assert.equal(research.status, "blocked");
  assert.equal(research.attempt, 2);
  assert.equal(research.error.code, "context_budget_exceeded");
  assert.equal(research.error.retryable, false);
  assert.match(research.error.message, /context window exhausted/);
  assert.equal(researchCalls, 2);
  assert.match(snapshot.blockedReason, /context window exhausted|reached 2 attempts/);
});

test("Review phase retry reruns semantic review and publication without duplicating validation", async (t) => {
  const f = await fixture(t, { spec: spec() });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const initial = await f.engine.waitForIdle();
  assert.equal(initial.status, "succeeded");

  await f.engine.retryPhase("review");
  const retried = await f.engine.waitForIdle();

  assert.equal(retried.status, "succeeded");
  assert.equal(retried.nodes.some((node) => node.status === "queued"), false);
  assert.equal(retried.nodes.filter((node) => node.kind === "validate" && node.status === "succeeded").length, 1);
  assert.equal(retried.nodes.filter((node) => node.kind === "review" && node.status === "succeeded").length, 1);
  assert.equal(retried.nodes.filter((node) => node.kind === "finalize" && node.status === "succeeded").length, 1);
  assert.equal(retried.nodes.find((node) => node.kind === "validate").attempt, 1);
  assert.equal(retried.nodes.filter((node) => node.kind === "review").length, 1);
  assert.equal(retried.nodes.find((node) => node.kind === "review" && node.status === "succeeded").attempt, 2);
});

test("refresh writes only impacted/new content and always rewrites Overview", async (t) => {
  const target = spec();
  const f = await fixture(t, {
    spec: target,
    inspection: {
      existingPages: ["overview/overview.md", "core/domain.md", "core/architecture.md", "api/domain.md", "api/request-flow.md"],
      impactedPages: ["wiki/api/request-flow.md"],
    },
  });
  f.engine.start({ cwd: f.workspace, mode: "refresh" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded");
  assert.deepEqual(f.writes.map(({ request }) => request.node.input.page.path), ["api/request-flow.md", "overview/overview.md"]);
  const impactedWriter = f.requests.find((request) => request.node.kind === "write" && request.node.input.page.path === "api/request-flow.md");
  assert.deepEqual(impactedWriter.wikiReadPaths, ["wiki/api/request-flow.md", "wiki/core/architecture.md"], "only its own page and a retained cross-link neighbor are readable");
  const synthesis = f.requests.find((request) => request.node.kind === "synthesis");
  assert.deepEqual(synthesis.wikiReadPaths, ["wiki/api/domain.md", "wiki/api/request-flow.md", "wiki/core/architecture.md", "wiki/core/domain.md", "wiki/overview/overview.md"]);
});

test("refresh explicitly requires generate for a legacy Wiki contract", async (t) => {
  const f = await fixture(t, {
    inspection: { refreshRequiresGenerateReason: "Existing Wiki uses legacy source citations; run /wiki generate" },
  });

  f.engine.start({ cwd: f.workspace, mode: "refresh" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.nodes.find((node) => node.kind === "inspect").error.message, /run \/wiki generate/);
  assert.equal(snapshot.nodes.some((node) => node.kind === "research"), false);
});

test("mixed structural and local defects replan first, write the full topology, and retain page feedback", async (t) => {
  const target = spec();
  const f = await fixture(t, {
    spec: target,
    inspection: {
      existingPages: ["overview/overview.md", "core/domain.md", "core/architecture.md", "api/domain.md", "api/request-flow.md"],
      impactedPages: ["core/architecture.md"],
    },
    synthesis: (_request, index) => ({ decision: "finalize", spec: target, rationale: `plan-${index}` }),
    review: (_request, index) => index === 0 ? {
      defects: [
        { kind: "topology", detail: "The page topology is incomplete." },
        { kind: "depth", page: "core/architecture.md", detail: "Explain the boundary." },
      ],
      summary: "Replan and preserve the local defect.",
    } : { defects: [], summary: "complete" },
  });
  f.engine.start({ cwd: f.workspace, mode: "refresh" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded");
  // Initial survey finalize + structural replan (no forced dry audit without critical gaps).
  assert.equal(snapshot.nodes.filter((node) => node.kind === "synthesis").length, 2);
  const structuralPlanNode = snapshot.nodes.filter((node) => node.kind === "synthesis" && node.input.mode === "structural").at(-1);
  const structuralWrites = snapshot.nodes.filter((node) => node.kind === "write" && node.input.synthesisNodeId === structuralPlanNode.id);
  assert.equal(structuralWrites.length, 5, "structural Plan rewrites every target page");
  const feedback = structuralWrites.find((node) => node.input.page.path === "core/architecture.md").input.feedback.review.defects[0];
  assert.equal(feedback.kind, "depth");
  assert.equal(feedback.domainId, "core");
  assert.match(feedback.id, /^defect-[a-f0-9]{12}$/);
  assert.equal(structuralWrites.every((node) => node.input.intent !== "repair"), true);
  const structuralPlan = f.requests.filter((request) => request.node.kind === "synthesis" && request.node.input.mode === "structural").at(-1);
  assert.match(structuralPlan.prompt, /Prior Final WikiSpec/);
  assert.match(structuralPlan.prompt, /"sharedTerms"/);
  assert.match(structuralPlan.prompt, /"kind": "topology"/);
  assert.doesNotMatch(structuralPlan.prompt, /defect-[a-f0-9]{12}|domainId/);
  const repairedPage = f.requests.find((request) => request.node.kind === "write"
    && request.node.input.synthesisNodeId === structuralPlan.node.id
    && request.node.input.page.path === "core/architecture.md");
  assert.match(repairedPage.prompt, /"kind": "depth"/);
  assert.doesNotMatch(repairedPage.prompt, /defect-[a-f0-9]{12}|domainId/);
});

test("targeted research is allowed once and carries all receipts into the next Plan", async (t) => {
  const target = spec();
  // Expand requires unresolved critical gaps on research receipts (hard-reject otherwise).
  const f = await fixture(t, {
    onResearch: async (request) => {
      const batch = request.node.input.batch;
      if (batch === 0) {
        return {
          result: {
            summary: `Covered ${request.node.input.scope.sourcePaths.join(", ")}`,
            findings: request.node.input.scope.sourcePaths.map((source) => ({
              kind: "domain",
              title: `${source} responsibilities`,
              readerQuestion: `What does ${source} own?`,
              priority: "critical",
              evidence: [`${source}/index.ts#L1`],
            })),
            gaps: [{
              priority: "critical",
              question: "How do src-core and src-api hand off requests?",
              sourcePaths: request.node.input.scope.sourcePaths,
            }],
          },
        };
      }
      return { result: { summary: "Supplemental closed the gap", findings: [], gaps: [] } };
    },
    synthesis: (request, index) => {
      if (index === 0) {
        // Submit-time expand is only legal while critical gaps remain.
        request.validateControlSubmission({
          decision: "expand",
          researchScopes: [{
            id: "cross-boundary",
            sourcePaths: ["src-core", "src-api"],
            task: "How do src-core and src-api hand off requests?",
          }],
          rationale: "One bounded gap remains.",
        });
        return {
          decision: "expand",
          researchScopes: [{
            id: "cross-boundary",
            sourcePaths: ["src-core", "src-api"],
            task: "How do src-core and src-api hand off requests?",
          }],
          rationale: "One bounded gap remains.",
        };
      }
      return { decision: "finalize", spec: target, rationale: "Complete." };
    },
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  const syntheses = f.requests.filter((request) => request.node.kind === "synthesis");
  // Expand plan + post-expand finalize (queues coverage audit while survey gaps remain)
  // + post-audit finalize once requiredDryCoverageAudits is satisfied.
  assert.equal(syntheses.length, 3);
  assert.equal(syntheses[1].artifactPaths.length, 3);
  for (const scopeId of ["source-survey:src-core", "source-survey:src-api", "cross-boundary"]) {
    assert.match(syntheses[1].prompt, new RegExp(`"scopeId": "${scopeId}"`));
  }
  for (const artifactPath of syntheses[1].artifactPaths) {
    assert.match(artifactPath, /^\.okf-wiki\/blobs\/[a-f0-9]{64}\.json$/);
    assert.match(syntheses[1].prompt, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(syntheses[1].prompt, /Use only the exact finding `id` values below/);
  assert.deepEqual(f.requests.find((request) => request.node.input?.scope?.id === "cross-boundary").readRoots, ["src-core", "src-api"]);
});

test("Plan receipt manifest exposes the exact scope allowlist enforced at submission", async (t) => {
  const target = spec();
  const f = await fixture(t, {
    synthesis: (request) => {
      const invalid = structuredClone(target);
      invalid.domains[1].pages[0].findingIds = ["src-core"];
      assert.throws(
        () => request.validateControlSubmission({ decision: "finalize", spec: invalid, rationale: "Guessed an ID." }),
        /references unknown research finding: src-core/,
      );
      assert.doesNotThrow(() => request.validateControlSubmission({
        decision: "finalize",
        spec: target,
        rationale: "Selected exact manifest IDs.",
      }));
      assert.match(request.prompt, /"scopeId": "source-survey:src-core"/);
      assert.match(request.prompt, /"sourcePaths": \[\s*"src-core"/);
      assert.match(request.prompt, /"task": "Survey src-core to identify cohesive domains/);
      return { decision: "finalize", spec: target, rationale: "Selected exact manifest IDs." };
    },
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  assert.equal((await f.engine.waitForIdle()).status, "succeeded");
});

test("source drift invalidation permits the restarted branch to request the same supplemental scope", async (t) => {
  const target = spec();
  const f = await fixture(t, {
    inspectionSequence: [
      { sourceFingerprint: "source-1" },
      { sourceFingerprint: "source-2", head: "head-2" },
      { sourceFingerprint: "source-2", head: "head-2" },
      { sourceFingerprint: "source-2", head: "head-2" },
    ],
    onResearch: async (request) => {
      const batch = request.node.input.batch;
      if (batch === 0) {
        return {
          result: {
            summary: `Covered ${request.node.input.scope.sourcePaths.join(", ")}`,
            findings: request.node.input.scope.sourcePaths.map((source) => ({
              kind: "domain",
              title: `${source} responsibilities`,
              readerQuestion: `What does ${source} own?`,
              priority: "critical",
              evidence: [`${source}/index.ts#L1`],
            })),
            gaps: [{
              priority: "critical",
              question: "What is the current implementation gap?",
              sourcePaths: request.node.input.scope.sourcePaths,
            }],
          },
        };
      }
      return { result: { summary: "Supplemental closed the gap", findings: [], gaps: [] } };
    },
    synthesis: (request) => request.node.input.supplementalBatch === 0 ? {
      decision: "expand",
      researchScopes: [{
        id: "same-gap",
        sourcePaths: ["src-core"],
        task: "What is the current implementation gap?",
      }],
      rationale: "One bounded gap remains.",
    } : { decision: "finalize", spec: target, rationale: "Complete." },
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  const repeatedScopes = snapshot.nodes.filter((node) => node.kind === "research" && node.input.scope.id === "same-gap");
  assert.equal(repeatedScopes.length, 2);
  assert.deepEqual(repeatedScopes.map((node) => node.status), ["invalidated", "succeeded"]);
});

test("static page issues route to one fresh repair writer and regenerate Overview", async (t) => {
  const f = await fixture(t, {
    validate: (_spec, index) => index === 0
      ? validation({ ok: false, issues: [{ code: "frontmatter", page: "core/architecture.md", message: "Missing title" }] })
      : validation(),
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded");
  const repairs = snapshot.nodes.filter((node) => node.kind === "write" && node.input.intent === "repair");
  assert.deepEqual(repairs.map((node) => node.input.page.path).sort(), ["core/architecture.md", "overview/overview.md"]);
  assert.ok(repairs.every((node) => node.phaseId === "write"));
});

test("local reviewer defects use fresh page repairs and merge an Overview defect into the same rewrite", async (t) => {
  const f = await fixture(t, {
    review: (_request, index) => index === 0 ? {
      defects: [
        { kind: "depth", page: "api/request-flow.md", detail: "Explain failure behavior." },
        { kind: "link", page: "overview/overview.md", detail: "Link the request flow." },
      ],
      summary: "Repair one content page and Overview.",
    } : { defects: [], summary: "complete" },
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded");
  const repairs = snapshot.nodes.filter((node) => node.kind === "write" && node.input.intent === "repair");
  assert.deepEqual(repairs.map((node) => node.input.page.path).sort(), ["api/request-flow.md", "overview/overview.md"]);
  const apiRepair = repairs.find((node) => node.input.page.path === "api/request-flow.md");
  const overviewRepair = repairs.find((node) => node.input.page.path === "overview/overview.md");
  assert.equal(apiRepair.input.feedback.review.defects[0].domainId, "api");
  assert.equal(apiRepair.input.feedback.review.defects.length, 1);
  assert.equal(Object.hasOwn(apiRepair.input.feedback.review, "summary"), false);
  assert.equal(overviewRepair.input.feedback.review.defects[0].kind, "link");
  const overviewRequest = f.requests.find((request) => request.node.id === overviewRepair.id);
  assert.deepEqual(overviewRequest.readRoots, ["src-core", "src-api"]);
  assert.equal(f.finalizationCalls, 1);
});

test("repeated normalized validation issues block without another repair", async (t) => {
  const f = await fixture(t, {
    validate: () => validation({ ok: false, issues: [{ code: "link", page: "api/request-flow.md", message: " Broken   link " }] }),
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "blocked");
  assert.match(snapshot.blockedReason, /same unresolved error set/);
  assert.equal(snapshot.blockedDetails?.code, "same_validation_twice");
  assert.equal(snapshot.blockedDetails?.issues?.[0]?.code, "link");
  assert.equal(snapshot.nodes.filter((node) => node.kind === "write" && node.input.intent === "repair").length, 2);
  assert.equal(f.finalizationCalls, 0);
});

test("an unchanged defect-target repair blocks immediately", async (t) => {
  let original;
  const f = await fixture(t, {
    validate: (_spec, index) => index === 0
      ? validation({ ok: false, issues: [{ code: "depth", page: "core/architecture.md", message: "Too shallow" }] })
      : validation(),
    onWrite: async (request, index) => {
      const output = request.writePaths[0];
      const absolute = path.join(request.candidateWikiRoot, output.replace(/^wiki\//, ""));
      await mkdir(path.dirname(absolute), { recursive: true });
      if (request.node.input.page.path === "core/architecture.md" && request.node.input.intent === "draft") {
        original = "unchanged\n";
        await writeFile(absolute, original);
        return true;
      }
      if (request.node.input.page.path === "core/architecture.md" && request.node.input.intent === "repair") {
        await writeFile(absolute, original);
        return true;
      }
      await writeFile(absolute, `write-${index}\n`);
      return true;
    },
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "blocked");
  assert.match(snapshot.blockedReason, /made no change to core\/architecture\.md/);
  assert.equal(snapshot.blockedDetails?.code, "repair_no_progress");
  assert.equal(snapshot.blockedDetails?.page, "core/architecture.md");
});

test("a writer cannot submit a missing content page", async (t) => {
  const f = await fixture(t, {
    validate: (_spec, index) => index === 0
      ? validation({ ok: false, issues: [{ code: "missing-page", page: "core/architecture.md", message: "Page is missing" }] })
      : validation(),
    onWrite: async (request) => request.node.input.page.path === "core/architecture.md",
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.nodes.find((node) => node.kind === "write" && node.status === "failed").error.message, /false !== true/);
});

test("a writer cannot submit a missing Overview", async (t) => {
  const f = await fixture(t, {
    validate: (_spec, index) => index === 0
      ? validation({ ok: false, issues: [{ code: "missing-page", page: "overview/overview.md", message: "Overview is missing" }] })
      : validation(),
    onWrite: async (request) => request.node.input.page.pageType === "overview",
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();

  assert.equal(snapshot.status, "failed");
  assert.match(snapshot.nodes.find((node) => node.kind === "write" && node.status === "failed").error.message, /false !== true/);
  const overviewRequest = f.requests.find((request) => request.node.kind === "write"
    && request.node.input.page.pageType === "overview");
  assert.deepEqual(overviewRequest.readRoots, ["src-core", "src-api"]);
});

test("a Plan permits at most three local repair rounds", async (t) => {
  const f = await fixture(t, {
    validate: (_spec, index) => validation({
      ok: false,
      issues: [{ code: `depth-${index}`, page: "core/architecture.md", message: `Issue ${index}` }],
    }),
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "blocked");
  assert.match(snapshot.blockedReason, /3-round budget/);
  assert.equal(snapshot.blockedDetails?.code, "local_repair_budget");
  assert.equal(snapshot.blockedDetails?.remainingBudget?.localRepairRounds, 0);
  assert.equal(snapshot.blockedDetails?.remainingBudget?.maxLocalRepairRounds, 3);
  assert.equal(snapshot.blockedDetails?.remainingBudget?.used, 3);
  assert.equal(new Set(snapshot.nodes.filter((node) => node.kind === "write" && node.input.intent === "repair").map((node) => node.input.writeGroupId)).size, 3);
});

test("research expansion is bounded by expand-round budget", async (t) => {
  const f = await fixture(t, {
    research: async (request) => {
      if (request.node.input.continuationMode === "initial" || request.node.input.batch === 0) {
        return {
          result: {
            summary: "survey with open gap",
            findings: [{
              kind: "domain",
              title: "core domain",
              readerQuestion: "What does core own?",
              priority: "critical",
              evidence: ["src-core/index.ts#L1"],
            }],
            gaps: [{
              priority: "critical",
              question: "What remains for coverage expansion budget?",
              sourcePaths: ["src-core"],
            }],
          },
        };
      }
      return {
        result: {
          summary: "supplemental still open",
          findings: [],
          gaps: [{
            priority: "critical",
            question: "What remains for coverage expansion budget?",
            sourcePaths: ["src-core"],
          }],
        },
      };
    },
    synthesis: (_request, index) => ({
      decision: "expand",
      researchScopes: [{
        id: `gap-${index}`,
        sourcePaths: ["src-core"],
        task: "What remains for coverage expansion budget?",
      }],
      rationale: "More research requested.",
    }),
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "blocked");
  // Default policy: maxExpandRounds=4 (initial survey is free; supplemental/structural count).
  assert.match(snapshot.blockedReason, /4-expand-round limit/);
  assert.equal(snapshot.nodes.filter((node) => node.kind === "research" && node.input.batch > 0).length, 4);
  const blocked = snapshot.nodes.find((node) => node.status === "blocked");
  assert.equal(blocked?.error?.code, "expand_rounds_exhausted");
  assert.equal(snapshot.blockedDetails?.code, "expand_rounds_exhausted");
  assert.equal(typeof snapshot.blockedDetails?.remainingBudget?.used, "number");
  assert.equal(snapshot.blockedDetails?.remainingBudget?.maxExpandRounds, 4);
});

test("finalization is skipped until review passes", async (t) => {
  const f = await fixture(t, {
    review: () => ({ defects: [{ kind: "coverage", detail: "Still incomplete." }], summary: "replan" }),
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "blocked");
  assert.match(snapshot.blockedReason, /same unresolved defect set|Structural review exceeded/);
  assert.equal(f.finalizationCalls, 0);
});

test("one source drift restarts from Inspect while a second drift blocks", async (t) => {
  const f = await fixture(t, {
    inspectionSequence: [
      { sourceFingerprint: "source-1" },
      { sourceFingerprint: "source-2", head: "head-2" },
      { sourceFingerprint: "source-2", head: "head-2" },
      { sourceFingerprint: "source-2", head: "head-2" },
    ],
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const success = await f.engine.waitForIdle();
  assert.equal(success.status, "succeeded");
  assert.equal(success.sourceRestartCount, 1);
  assert.equal(success.nodes.filter((node) => node.kind === "inspect").length, 2);

  const g = await fixture(t, {
    inspectionSequence: [
      { sourceFingerprint: "one" },
      { sourceFingerprint: "two" },
      { sourceFingerprint: "two" },
      { sourceFingerprint: "three" },
    ],
  });
  g.engine.start({ cwd: g.workspace, mode: "generate" });
  const blocked = await g.engine.waitForIdle();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.sourceRestartCount, 1);
  assert.match(blocked.blockedReason, /changed twice/);
  assert.equal(blocked.blockedDetails?.code, "source_drift_blocked");
  assert.equal(g.finalizationCalls, 0);
});

test("Git reconciliation after a source-drift restart retries the latest valid Inspect branch", async (t) => {
  const f = await fixture(t, {
    inspectionSequence: [
      { sourceFingerprint: "one", head: "head-1" },
      { sourceFingerprint: "two", head: "head-2" },
      { sourceFingerprint: "two", head: "head-2" },
      { sourceFingerprint: "two", head: "head-2" },
      { sourceFingerprint: "two", head: "head-2" },
      { sourceFingerprint: "three", head: "head-3" },
      { sourceFingerprint: "three", head: "head-3" },
      { sourceFingerprint: "three", head: "head-3" },
      { sourceFingerprint: "three", head: "head-3" },
    ],
  });
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const restarted = await f.engine.waitForIdle();
  assert.equal(restarted.status, "succeeded");
  assert.equal(restarted.nodes.filter((node) => node.kind === "inspect").length, 2);

  await f.engine.retryPhase("review");
  const reconciled = await f.engine.waitForIdle();
  const inspectNodes = reconciled.nodes.filter((node) => node.kind === "inspect");

  assert.equal(reconciled.status, "succeeded");
  assert.equal(inspectNodes.length, 2);
  assert.equal(inspectNodes[0].status, "invalidated");
  assert.equal(inspectNodes[0].attempt, 1);
  assert.equal(inspectNodes[1].status, "succeeded");
  assert.equal(inspectNodes[1].attempt, 2);
  assert.equal(reconciled.inspection.sourceFingerprint, "three");
});

test("succeeded nodes drop live history/output; archiveAttempt stays slim", async (t) => {
  const f = await fixture(t, {
    onResearch: async (request) => {
      // First attempt on one scope: retryable context budget so archiveAttempt runs.
      if (request.node.attempt === 1 && request.node.input.scope.id.includes("src-core")) {
        throw new WikiAgentContextBudgetError(
          "first attempt partial output",
          [{ at: "2026-08-10T00:00:00.000Z", kind: "message", text: "heavy history from failed attempt" }],
          "context overflow recovery failed",
        );
      }
      const findings = request.node.input.batch === 0
        ? request.node.input.scope.sourcePaths.map((source) => ({
          kind: "domain",
          title: `${source} responsibilities`,
          readerQuestion: `What does ${source} own?`,
          priority: "critical",
          evidence: [`${source}/index.ts#L1`],
        }))
        : [];
      return {
        result: {
          summary: `Covered ${request.node.input.scope.sourcePaths.join(", ")}`,
          findings,
          gaps: [],
        },
        output: "success assistant output that must not stay on the node",
        history: [{ at: "2026-08-10T00:00:00.000Z", kind: "message", text: "success history that must not stay" }],
        metrics: { outputTokens: 7 },
      };
    },
  });

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded");

  const research = snapshot.nodes.filter((node) => node.kind === "research");
  assert.ok(research.length >= 1);
  for (const node of research) {
    assert.equal(node.status, "succeeded");
    assert.equal(node.history, undefined, "live history cleared after success");
    assert.equal(node.output, undefined, "live output cleared after success");
    assert.ok(node.result !== undefined || node.handoff, "durable result/handoff retained");
  }

  const retried = research.find((node) => node.attemptHistory.length > 0);
  assert.ok(retried, "retryable failure should archive the prior attempt");
  for (const archived of retried.attemptHistory) {
    assert.equal(archived.result, undefined, "archive omits full result clones");
    assert.equal(archived.output, undefined, "archive omits full output clones");
    assert.equal(archived.history, undefined, "archive omits full history clones");
    assert.ok(archived.metrics, "archive keeps metrics");
    assert.ok(archived.error, "failed archive keeps error metadata");
  }

  // serialize() is pointer-only (full body lives in history store).
  const session = f.engine.serialize();
  assert.equal(session?.customType, "okf-wiki-run");
  assert.equal(session?.workspace, f.workspace);
  assert.equal(session?.runId, snapshot.id);
  assert.equal(session?.status, snapshot.status);
  assert.equal(session?.pointerVersion, 1);
  assert.equal("snapshot" in (session ?? {}), false);
});

test("writers and reviewers use an unpublished candidate until atomic publication", async (t) => {
  let observedPublished = false;
  const f = await fixture(t, {
    onWrite: async (request) => {
      assert.match(request.candidateWikiRoot, /\.okf-wiki\/runs\/[^/]+\/candidate\/wiki$/);
      observedPublished ||= await readFile(path.join(request.cwd, "wiki", "old.md"), "utf8") === "old\n";
      return false;
    },
    review: async (request) => {
      assert.match(request.candidateWikiRoot, /\.okf-wiki\/runs\/[^/]+\/candidate\/wiki$/);
      assert.equal(await readFile(path.join(request.cwd, "wiki", "old.md"), "utf8"), "old\n");
      return { defects: [], summary: "complete" };
    },
  });
  await mkdir(path.join(f.workspace, "wiki"), { recursive: true });
  await writeFile(path.join(f.workspace, "wiki", "old.md"), "old\n", "utf8");

  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const snapshot = await f.engine.waitForIdle();
  assert.equal(snapshot.status, "succeeded", snapshot.blockedReason);
  assert.equal(observedPublished, true);
  await assert.rejects(readFile(path.join(f.workspace, "wiki", "old.md"), "utf8"), { code: "ENOENT" });
  assert.match(await readFile(path.join(f.workspace, "wiki", "overview", "overview.md"), "utf8"), /write-/);
});

test("forked validation retry copies the source run Wiki before preserving succeeded writers", async (t) => {
  const f = await fixture(t);
  f.engine.start({ cwd: f.workspace, mode: "generate" });
  const source = await f.engine.waitForIdle();
  assert.equal(source.status, "succeeded", source.blockedReason);
  const validateNode = source.nodes.find((node) => node.kind === "validate");
  assert.ok(validateNode);

  await f.engine.forkAndRetryNode(source, validateNode.id);
  const fork = await f.engine.waitForIdle();
  assert.equal(fork.status, "succeeded", fork.blockedReason);
  assert.equal(fork.parentRunId, source.id);
  assert.deepEqual(fork.policy, source.policy);
  assert.equal(fork.policyHash, source.policyHash);
  assert.ok(fork.nodes.some((node) => node.kind === "write" && node.status === "succeeded" && node.attempt === 1));
  assert.match(await readFile(path.join(f.workspace, "wiki", "overview", "overview.md"), "utf8"), /write-/);
});
