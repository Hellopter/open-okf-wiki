import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  defaultWikiRunSpec,
  type WikiRunSpec,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import { runWorkdirLayout } from "../pi/run-workdir.js";
import {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
} from "./produce-runtime.js";
import type { ProduceProgress } from "./progress.js";
import { produceWiki } from "./produce-wiki.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

async function makeWorkspace(root: string) {
  const src = path.join(root, "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "README.md"), "# Src\nline2\n", "utf8");
  const skill = path.join(root, "skill");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  return {
    workspace: WorkspaceConfigSchema.parse({
      version: 1,
      id: "ws",
      name: "Produce WS",
      rootPath: root,
      sources: [{ id: "main", path: src, applyDefaultIgnores: true, ignore: [] }],
      skillPath: skill,
      model: { id: "openai/test" },
      publicationPath: path.join(root, "out"),
      limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
      planConfirm: false,
      wikiLanguage: "en",
      createdAt: new Date().toISOString(),
    }),
    src,
    skill,
  };
}

async function makeRunLayout(root: string, runId = "run-1") {
  const runWorkDir = path.join(root, ".okf-wiki", "runs", runId);
  const source = path.join(runWorkDir, "sources", "main");
  await mkdir(path.join(runWorkDir, "skill"), { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "README.md"), "# Frozen source\n", "utf8");
  await writeFile(path.join(runWorkDir, "skill", "SKILL.md"), "# Frozen skill\n", "utf8");
  return {
    runWorkDir,
    layout: runWorkdirLayout(runWorkDir, new Map([["main", source]])),
  };
}

describe("produceWiki fixture core flows", () => {
  it("happy path: research, write, clean review, ready_for_publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root);
    const progress: ProduceProgress[] = [];

    const result = await produceWiki({
      runId: "run-1",
      workspace,
      layout,
      spec: defaultWikiRunSpec(workspace.name),
      runtime: createFixtureProduceRuntime(),
      onProgress: (p) => progress.push(p),
    });

    assert.equal(result.status, "ready_for_publish");
    assert.ok(result.pages.includes("overview.md"));
    assert.equal(result.publishability.publishable, true);
    assert.ok(result.defects?.clean);
    assert.ok(result.metrics.domainStarts >= 1);
    assert.ok(result.metrics.leafStarts >= 1);
    assert.ok(progress.some((p) => p.kind === "phase" || p.kind === "status"));

    const receiptDir = path.join(root, ".okf-wiki", "runs", "run-1", "analysis", "receipts");
    const receiptFiles = await readdir(receiptDir).catch(() => [] as string[]);
    assert.ok(receiptFiles.some((f) => f.endsWith(".json")));
  });

  it("critical domain failure → failed (not publishable)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-crit-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-crit");
    const spec = defaultWikiRunSpec(workspace.name);
    const domainId = spec.domains[0]!.id;

    const result = await produceWiki({
      runId: "run-crit",
      workspace,
      layout,
      spec,
      runtime: createScriptedReviewFixtureRuntime({
        blockingRounds: 0,
        failDomainId: domainId,
        failDomainMessage: "boom domain",
      }),
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /Critical domain|boom domain/i);
    assert.equal(result.publishability.publishable, false);
    assert.equal(result.pages.length, 0);
  });

  it("blocking review then repair to clean → ready_for_publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-repair-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-repair");
    const spec: WikiRunSpec = {
      ...defaultWikiRunSpec(workspace.name),
      acceptance: {
        ...defaultWikiRunSpec(workspace.name).acceptance,
        maxRepairRounds: 2,
      },
    };

    const result = await produceWiki({
      runId: "run-repair",
      workspace,
      layout,
      spec,
      runtime: createScriptedReviewFixtureRuntime({ blockingRounds: 1 }),
    });

    assert.equal(result.status, "ready_for_publish");
    assert.equal(result.metrics.repairRounds, 1);
    assert.ok(result.defects?.clean || !result.defects?.defects.some((d) => d.severity === "blocking"));
  });

  it("blocking defects exhaust maxRepair → failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-exhaust-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-exhaust");
    const base = defaultWikiRunSpec(workspace.name);
    const spec: WikiRunSpec = {
      ...base,
      acceptance: {
        ...base.acceptance,
        maxRepairRounds: 1,
      },
    };

    const result = await produceWiki({
      runId: "run-exhaust",
      workspace,
      layout,
      spec,
      runtime: createScriptedReviewFixtureRuntime({ blockingRounds: 99 }),
    });

    assert.equal(result.status, "failed");
    assert.ok(result.metrics.repairRounds >= 1);
    assert.equal(result.publishability.publishable, false);
    assert.ok(result.defects && result.defects.defects.length > 0);
  });

  it("abort mid-research → cancelled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-cancel-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-cancel");
    const ac = new AbortController();
    ac.abort();

    const result = await produceWiki({
      runId: "run-cancel",
      workspace,
      layout,
      spec: defaultWikiRunSpec(workspace.name),
      runtime: createFixtureProduceRuntime(),
      abortSignal: ac.signal,
    });

    assert.equal(result.status, "cancelled");
    assert.match(result.summary, /cancel/i);
  });

  it("live runtime without reviewer model is not silently clean", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-norev-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-norev");

    // Fixture research/write, but force live-shaped review path via custom runtime:
    // use fixture runtime for agents/write, then we unit-test the policy branch by
    // constructing a hybrid: kind live without models.
    const fixture = createFixtureProduceRuntime();
    const hybrid = {
      kind: "live" as const,
      runAgent: fixture.runAgent.bind(fixture),
      runAgentsParallel: fixture.runAgentsParallel.bind(fixture),
      writeWiki: fixture.writeWiki.bind(fixture),
    };

    const result = await produceWiki({
      runId: "run-norev",
      workspace,
      layout,
      spec: defaultWikiRunSpec(workspace.name),
      runtime: hybrid,
      // no models.reviewer
    });

    assert.equal(result.status, "failed");
    assert.ok(
      result.defects?.defects.some((d) => d.code === "reviewer_missing") ||
        /reviewer model|hard-validate|blocking/i.test(result.summary),
    );
  });
});
