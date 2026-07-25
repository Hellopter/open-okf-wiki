import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WorkspaceConfigSchema } from "@okf-wiki/contract";
import type { FrozenRunBoundary } from "@okf-wiki/core";
import {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
} from "./produce-runtime.js";
import {
  type WikiProduceGateCoordinator,
  type WikiProduceGateDecision,
  type WikiProduceGateRequest,
  runWiki,
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
});

