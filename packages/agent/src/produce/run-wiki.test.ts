import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec, WorkspaceConfigSchema } from "@okf-wiki/contract";
import { type FrozenRunBoundary, loadRunGraph } from "@okf-wiki/core";
import { PLAN_DRAFT_REL_PATH, writePlanDraft } from "./living-spec.js";
import {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
} from "./produce-runtime.js";
import {
  resolveModels,
  runWiki,
  type WikiProduceGateCoordinator,
  type WikiProduceGateDecision,
  type WikiProduceGateRequest,
} from "./run-wiki.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await import("node:fs/promises").then((fs) => fs.rm(t, { recursive: true, force: true }));
  }
});

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-runwiki-"));
  temps.push(root);
  const source = path.join(root, "source");
  const skill = path.join(root, "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(source, "README.md"), "# S\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  return WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws",
    name: "RunWiki",
    rootPath: root,
    sources: [{ id: "main", path: source, applyDefaultIgnores: true, ignore: [] }],
    skillPath: skill,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "published"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: true,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });
}

async function fakeFreeze(
  workspace: ReturnType<typeof WorkspaceConfigSchema.parse>,
  sessionId: string,
): Promise<FrozenRunBoundary> {
  const runId = `run-${sessionId}`;
  const runWorkDir = path.join(workspace.rootPath, ".okf-wiki", "runs", runId);
  const source = path.join(runWorkDir, "sources", "main");
  const skillPath = path.join(runWorkDir, "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(source, "README.md"), "# frozen\n", "utf8");
  await writeFile(path.join(skillPath, "SKILL.md"), "# skill\n", "utf8");
  // register minimal run record via update path is optional; produce needs workspace root
  const { registerRunRecord } = await import("@okf-wiki/core");
  const skillDigest = "a".repeat(64);
  const revision = "b".repeat(40);
  await registerRunRecord(workspace.rootPath, workspace.id, {
    autoApprove: false,
    skillPath,
    skillDigest,
    sessionId,
    sources: [
      {
        id: "main",
        revision,
        effectiveIgnores: [],
      },
    ],
    runId,
    status: "running",
  });
  return {
    runId,
    runWorkDir,
    wikiDir: path.join(runWorkDir, "wiki"),
    analysisDir: path.join(runWorkDir, "analysis"),
    skillPath,
    skillDigest,
    sources: [
      {
        id: "main",
        revision,
        effectiveIgnores: [],
        path: source,
      },
    ],
    sourcePathMap: new Map([["main", source]]),
    sourceIgnores: new Map([["main", []]]),
  };
}

function gateHarness() {
  const requests: WikiProduceGateRequest[] = [];
  const decisions: Array<(d: WikiProduceGateDecision) => void> = [];
  const arrivals: Array<() => void> = [];
  let consumed = 0;
  return {
    requests,
    gateCoordinator: {
      waitForDecision(request: WikiProduceGateRequest): Promise<WikiProduceGateDecision> {
        requests.push(request);
        arrivals.shift()?.();
        return new Promise((resolve) => decisions.push(resolve));
      },
    } satisfies WikiProduceGateCoordinator,
    async nextRequest(): Promise<WikiProduceGateRequest> {
      if (consumed >= requests.length) {
        await new Promise<void>((resolve) => arrivals.push(resolve));
      }
      return requests[consumed++]!;
    },
    resolve(decision: WikiProduceGateDecision): void {
      const r = decisions.shift();
      assert.ok(r);
      r(decision);
    },
  };
}

describe("runWiki core flows", () => {
  it("plan approve → produce → publication approve → published", async () => {
    const workspace = await makeWorkspace();
    const gates = gateHarness();
    let published = 0;
    const details: Array<{ status?: string }> = [];

    const done = runWiki({
      workspace,
      sessionId: "s1",
      toolCallId: "t1",
      gateCoordinator: gates.gateCoordinator,
      fixture: true,
      runtime: createFixtureProduceRuntime(),
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => {
        published += 1;
        return { publicationPath: workspace.publicationPath!, pageCount: 2 };
      },
      onDetails: (p) => details.push(p),
    });

    const planReq = await gates.nextRequest();
    assert.equal(planReq.gate, "plan");
    gates.resolve({ action: "approve" });
    const pubReq = await gates.nextRequest();
    assert.equal(pubReq.gate, "publication");
    gates.resolve({ action: "approve" });

    const result = await done;
    assert.equal(result.status, "published");
    assert.equal(published, 1);
    assert.ok(details.some((d) => d.status === "awaiting_plan"));
    assert.ok(details.some((d) => d.status === "awaiting_publication"));
  });

  it("persists final live graph with attempts to analysis/run-graph.json", async () => {
    const workspace = await makeWorkspace();
    const result = await runWiki({
      workspace,
      sessionId: "s-graph",
      toolCallId: "t-graph",
      autoApprove: true,
      gateCoordinator: {
        waitForDecision: async () => ({ action: "approve" as const }),
      },
      fixture: true,
      runtime: createFixtureProduceRuntime(),
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => ({
        publicationPath: workspace.publicationPath!,
        pageCount: 2,
      }),
    });

    assert.equal(result.status, "published");
    assert.ok(result.runId);
    const graph = await loadRunGraph(workspace.rootPath, result.runId!);
    assert.ok(graph, "expected durable run-graph.json");
    assert.ok(graph!.topology.length >= 1, "expected topology nodes");
    assert.ok(
      graph!.attempts.length >= 1,
      `expected attempts after fixture agents ran, got ${graph!.attempts.length}`,
    );
    assert.ok(
      graph!.attempts.some((a) => a.role === "plan" || a.nodeKey === "plan"),
      "expected plan attempt in durable graph",
    );
  });

  it("accepts injected memory GraphStore and ProgressSink (save/load without core disk)", async () => {
    const workspace = await makeWorkspace();
    const snapshots = new Map<string, import("@okf-wiki/contract").RunGraphSnapshot>();
    let saveCalls = 0;
    const graphStore = {
      async save(runId: string, snapshot: import("@okf-wiki/contract").RunGraphSnapshot) {
        saveCalls += 1;
        snapshots.set(runId, {
          topologyVersion: snapshot.topologyVersion,
          topology: [...snapshot.topology],
          attempts: [...snapshot.attempts],
          ...(snapshot.playhead ? { playhead: { ...snapshot.playhead } } : {}),
        });
      },
      async load(runId: string) {
        return snapshots.get(runId) ?? null;
      },
    };
    let sinkEmits = 0;
    const progressSink = {
      emit() {
        sinkEmits += 1;
      },
    };

    const result = await runWiki({
      workspace,
      sessionId: "s-inject",
      toolCallId: "t-inject",
      autoApprove: true,
      gateCoordinator: {
        waitForDecision: async () => ({ action: "approve" as const }),
      },
      fixture: true,
      runtime: createFixtureProduceRuntime(),
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => ({
        publicationPath: workspace.publicationPath!,
        pageCount: 2,
      }),
      graphStore,
      progressSink,
    });

    assert.equal(result.status, "published");
    assert.ok(result.runId);
    assert.ok(saveCalls >= 1, `expected memory GraphStore.save, got ${saveCalls}`);
    assert.ok(sinkEmits >= 1, `expected ProgressSink.emit, got ${sinkEmits}`);
    const loaded = await graphStore.load(result.runId!);
    assert.ok(loaded);
    assert.ok(loaded!.topology.length >= 1);
    assert.ok(loaded!.attempts.length >= 1);
  });

  it("plan deny → cancelled, no publish", async () => {
    const workspace = await makeWorkspace();
    const gates = gateHarness();
    let published = 0;
    const done = runWiki({
      workspace,
      sessionId: "s2",
      toolCallId: "t2",
      gateCoordinator: gates.gateCoordinator,
      fixture: true,
      runtime: createFixtureProduceRuntime(),
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => {
        published += 1;
        return { publicationPath: workspace.publicationPath!, pageCount: 0 };
      },
    });
    await gates.nextRequest();
    gates.resolve({ action: "deny" });
    const result = await done;
    assert.equal(result.status, "cancelled");
    assert.equal(published, 0);
  });

  it("publication deny → publication_declined", async () => {
    const workspace = await makeWorkspace();
    const gates = gateHarness();
    let published = 0;
    const done = runWiki({
      workspace,
      sessionId: "s3",
      toolCallId: "t3",
      gateCoordinator: gates.gateCoordinator,
      fixture: true,
      runtime: createFixtureProduceRuntime(),
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => {
        published += 1;
        return { publicationPath: workspace.publicationPath!, pageCount: 0 };
      },
    });
    await gates.nextRequest();
    gates.resolve({ action: "approve" });
    await gates.nextRequest();
    gates.resolve({ action: "deny" });
    const result = await done;
    assert.equal(result.status, "publication_declined");
    assert.equal(published, 0);
  });

  it("produce failed → no publish", async () => {
    const workspace = await makeWorkspace();
    const gates = gateHarness();
    let published = 0;
    const done = runWiki({
      workspace,
      sessionId: "s4",
      toolCallId: "t4",
      gateCoordinator: gates.gateCoordinator,
      fixture: true,
      runtime: createScriptedReviewFixtureRuntime({
        blockingRounds: 99,
        failDomainId: "core",
      }),
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => {
        published += 1;
        return { publicationPath: workspace.publicationPath!, pageCount: 0 };
      },
    });
    await gates.nextRequest();
    gates.resolve({ action: "approve" });
    const result = await done;
    assert.equal(result.status, "failed");
    assert.equal(published, 0);
  });

  it("factory reviewer throw → reviewer_missing fail-closed", async () => {
    const workspace = await makeWorkspace();
    let published = 0;
    const fixture = createFixtureProduceRuntime({
      onAgent: async (req) => {
        if (req.role !== "plan") return undefined;
        const spec = defaultWikiRunSpec(workspace.name);
        await writePlanDraft(req.runWorkDir, spec);
        return {
          role: "plan",
          mode: "fixture",
          summary: `Plan submitted → ${PLAN_DRAFT_REL_PATH}`,
          specPath: PLAN_DRAFT_REL_PATH,
        };
      },
    });
    // Live-shaped runtime so produceWiki hits the reviewer_missing branch;
    // agents themselves stay fixture (no LLM).
    const hybrid = {
      kind: "live" as const,
      runAgent: fixture.runAgent.bind(fixture),
      runAgentsParallel: fixture.runAgentsParallel.bind(fixture),
      writeWiki: fixture.writeWiki.bind(fixture),
    };
    const stubModel = {
      id: "stub",
      name: "stub",
      api: "openai-completions",
      provider: "test",
      baseUrl: "http://localhost",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };

    const result = await runWiki({
      workspace,
      sessionId: "s-rev-miss",
      toolCallId: "t-rev",
      autoApprove: true,
      gateCoordinator: {
        waitForDecision: async () => ({ action: "approve" as const }),
      },
      fixture: false,
      runtime: hybrid,
      resolveModel: async (role) => {
        if (role === "reviewer") throw new Error("reviewer profile missing");
        return { model: stubModel as never };
      },
      freeze: async ({ sessionId }) => fakeFreeze(workspace, sessionId),
      publish: async () => {
        published += 1;
        return { publicationPath: workspace.publicationPath!, pageCount: 0 };
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(published, 0);
    assert.ok(
      result.defects?.defects.some((d) => d.code === "reviewer_missing"),
      `expected reviewer_missing defect, got: ${JSON.stringify(result.defects)}`,
    );
  });
});

describe("resolveModels fail-closed reviewer", () => {
  it("leaves reviewer undefined when factory throws; planner falls back to writer", async () => {
    const workspace = await makeWorkspace();
    const writer = { model: { id: "writer" } as never };
    const models = await resolveModels(
      async (role) => {
        if (role === "writer") return writer;
        if (role === "planner") throw new Error("no planner");
        if (role === "worker") throw new Error("no worker");
        if (role === "reviewer") throw new Error("no reviewer");
        throw new Error(`unexpected role ${role}`);
      },
      false,
      workspace,
    );
    assert.equal(models.writer, writer);
    assert.equal(models.planner, writer);
    assert.equal(models.worker, writer);
    assert.equal(models.reviewer, undefined);
  });

  it("keeps reviewer when factory succeeds", async () => {
    const workspace = await makeWorkspace();
    const writer = { model: { id: "writer" } as never };
    const reviewer = { model: { id: "reviewer" } as never };
    const models = await resolveModels(
      async (role) => {
        if (role === "reviewer") return reviewer;
        return writer;
      },
      false,
      workspace,
    );
    assert.equal(models.reviewer, reviewer);
  });
});
