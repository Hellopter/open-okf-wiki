import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec, type WikiRunSpec, WorkspaceConfigSchema } from "@okf-wiki/contract";
import type { ProduceProgress } from "../ports/progress-sink.js";
import {
  createFixtureProduceRuntime,
  createScriptedReviewFixtureRuntime,
} from "../runtime/produce-runtime.js";
import { runWorkdirLayout } from "../runtime/workdir.js";
import { produceWiki } from "../workflow/produce.js";
import {
  hardValidateRepairText,
  partitionHardValidateReasons,
} from "./phases/review-repair-phase.js";

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

describe("hardValidateRepairText", () => {
  it("formats mechanical reasons with citation guidance", () => {
    const text = hardValidateRepairText([
      "validation: overview.md: citation line range out of bounds (x; file has 10 lines)",
    ]);
    assert.match(text, /Hard-validate/);
    assert.match(text, /out of bounds/);
    assert.match(text, /read\/grep/);
  });

  it("strips indexes: reasons so models are not told to edit index.md", () => {
    const text = hardValidateRepairText([
      "indexes: missing index.md for directory with concepts: modules",
      "validation: overview.md: citation line range out of bounds (x; file has 10 lines)",
    ]);
    assert.doesNotMatch(text, /indexes:/);
    assert.match(text, /out of bounds/);
    assert.match(text, /Do not edit index\.md/);
  });
});

describe("partitionHardValidateReasons", () => {
  it("separates product-owned index failures from writer reasons", () => {
    const { indexReasons, writerReasons } = partitionHardValidateReasons([
      "indexes: concept not reachable from root index chain: modules/core.md",
      "missing critical page: overview.md",
      "validation: bad citation",
    ]);
    assert.deepEqual(indexReasons, [
      "indexes: concept not reachable from root index chain: modules/core.md",
    ]);
    assert.deepEqual(writerReasons, [
      "missing critical page: overview.md",
      "validation: bad citation",
    ]);
  });
});

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
    assert.equal(result.metrics.hardValidateRepairRounds, 0, "council repair must not spend HV budget");
    assert.ok(
      result.defects?.clean || !result.defects?.defects.some((d) => d.severity === "blocking"),
    );
  });

  it("review/repair attempts attach to topology nodes (multi-round append)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-review-graph-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-review-graph");
    const base = defaultWikiRunSpec(workspace.name);
    const spec: WikiRunSpec = {
      ...base,
      acceptance: {
        ...base.acceptance,
        maxRepairRounds: 2,
      },
    };

    const reviewAttempts = new Map<string, { nodeKey: string; runIndex: number; role?: string }>();
    const repairAttempts = new Map<string, { nodeKey: string; runIndex: number; role?: string }>();
    const rootWriteAttemptIds = new Set<string>();
    const result = await produceWiki({
      runId: "run-review-graph",
      workspace,
      layout,
      spec,
      runtime: createScriptedReviewFixtureRuntime({ blockingRounds: 1 }),
      onProgress: (p: ProduceProgress) => {
        if (p.kind !== "attempt") return;
        const a = p.attempt;
        if (a.role === "reviewer" || a.nodeKey === "review") {
          reviewAttempts.set(a.attemptId, {
            nodeKey: a.nodeKey,
            runIndex: a.runIndex,
            role: a.role,
          });
        }
        if (a.role === "repair" || a.nodeKey === "repair") {
          repairAttempts.set(a.attemptId, {
            nodeKey: a.nodeKey,
            runIndex: a.runIndex,
            role: a.role,
          });
        }
        if (a.nodeKey === "root_write" || a.role === "root_write") {
          rootWriteAttemptIds.add(a.attemptId);
        }
      },
    });

    assert.equal(result.status, "ready_for_publish");
    assert.equal(result.metrics.repairRounds, 1);
    assert.equal(result.metrics.hardValidateRepairRounds, 0);
    // Two council rounds (blocking then clean) → two attempts under the same topology node.
    assert.ok(reviewAttempts.size >= 2, `expected ≥2 review attempts, got ${reviewAttempts.size}`);
    for (const [attemptId, a] of reviewAttempts) {
      assert.equal(a.nodeKey, "review", `attempt ${attemptId} must map to topology review`);
      assert.equal(a.role, "reviewer");
      assert.match(attemptId, /^review@\d+:reviewer-\d+$/);
    }
    const reviewIndexes = [...reviewAttempts.values()].map((a) => a.runIndex).sort((x, y) => x - y);
    assert.ok(
      reviewIndexes.includes(0) && reviewIndexes.includes(1),
      `expected review runIndex 0 and 1, got ${reviewIndexes.join(",")}`,
    );
    // No orphan lens-keyed nodeKeys (pre-fix shape).
    assert.equal(
      [...reviewAttempts.values()].some((a) => a.nodeKey.startsWith("reviewer-")),
      false,
    );

    // One repair round after blocking review → single attempt under topology repair.
    assert.ok(repairAttempts.size >= 1, `expected ≥1 repair attempt, got ${repairAttempts.size}`);
    for (const [attemptId, a] of repairAttempts) {
      assert.equal(a.nodeKey, "repair", `attempt ${attemptId} must map to topology repair`);
      assert.equal(a.role, "repair");
      assert.match(attemptId, /^repair@\d+$/);
    }
    // Initial write stays on root_write; repair must not overwrite that attempt id.
    assert.ok(rootWriteAttemptIds.has("root_write"), "expected initial root_write attempt");
    assert.equal(
      [...repairAttempts.keys()].some((id) => id === "root_write"),
      false,
      "repair must not reuse root_write attemptId",
    );
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
    // Council exhaust must not burn mechanical HV budget on review-state reasons.
    assert.equal(result.metrics.hardValidateRepairRounds, 0);
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

  it("hard-validate citation OOB then repair → ready_for_publish", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-hv-repair-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-hv-repair");
    const base = defaultWikiRunSpec(workspace.name);
    const spec: WikiRunSpec = {
      ...base,
      acceptance: {
        ...base.acceptance,
        // Council budget 0: mechanical HV must still repair on its own budget.
        maxRepairRounds: 0,
        maxHardValidateRepairRounds: 2,
      },
    };

    const runtime = createFixtureProduceRuntime({
      onWrite: async (req, ordinal) => {
        // First write: citation end past file length (README has 1 line).
        // Repair write (ordinal ≥ 2): in-bounds citation.
        const citation =
          ordinal === 1 ? "[Source](repo:README.md#L1-L99)" : "[Source](repo:README.md#L1)";
        const pages = await writeCitationWiki(req.layout.wikiDir, citation);
        return {
          mode: "fixture" as const,
          layout: req.layout,
          pages,
          summary: ordinal === 1 ? "bad citation" : "fixed citation",
        };
      },
    });

    const result = await produceWiki({
      runId: "run-hv-repair",
      workspace,
      layout,
      spec,
      runtime,
    });

    assert.equal(result.status, "ready_for_publish", result.summary);
    assert.equal(result.publishability.publishable, true);
    assert.equal(result.metrics.repairRounds, 0, "HV must not spend council budget");
    assert.ok(result.metrics.hardValidateRepairRounds >= 1, "expected hard-validate repair round");
    const overview = await readFile(path.join(layout.wikiDir, "overview.md"), "utf8");
    assert.match(overview, /#L1(?!-L99)/);
    assert.doesNotMatch(overview, /#L1-L99/);
  });

  it("hard-validate OOB exhausts maxHardValidateRepairRounds → failed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-hv-exhaust-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-hv-exhaust");
    const base = defaultWikiRunSpec(workspace.name);
    const spec: WikiRunSpec = {
      ...base,
      acceptance: {
        ...base.acceptance,
        maxRepairRounds: 2,
        maxHardValidateRepairRounds: 1,
      },
    };

    const runtime = createFixtureProduceRuntime({
      onWrite: async (req) => {
        // Always write OOB citation — repair cannot clear hard-validate.
        const pages = await writeCitationWiki(
          req.layout.wikiDir,
          "[Source](repo:README.md#L1-L99)",
        );
        return {
          mode: "fixture" as const,
          layout: req.layout,
          pages,
          summary: "still bad citation",
        };
      },
    });

    const result = await produceWiki({
      runId: "run-hv-exhaust",
      workspace,
      layout,
      spec,
      runtime,
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /hard-validate|out of bounds|validation/i);
    assert.equal(result.publishability.publishable, false);
    assert.equal(result.metrics.hardValidateRepairRounds, 1);
    assert.equal(result.metrics.repairRounds, 0, "pre-council HV exhaust skips council");
  });

  it("council and hard-validate repair budgets are independent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-budget-split-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-budget-split");
    const base = defaultWikiRunSpec(workspace.name);
    const spec: WikiRunSpec = {
      ...base,
      acceptance: {
        ...base.acceptance,
        maxRepairRounds: 1,
        maxHardValidateRepairRounds: 1,
      },
    };

    // First write is citation-OOB (HV budget); after HV repair, council blocks once (council budget).
    let writeOrdinal = 0;
    let reviewerCalls = 0;
    const runtime = createFixtureProduceRuntime({
      onWrite: async (req, ordinal) => {
        writeOrdinal = ordinal;
        const citation =
          ordinal === 1 ? "[Source](repo:README.md#L1-L99)" : "[Source](repo:README.md#L1)";
        const pages = await writeCitationWiki(req.layout.wikiDir, citation);
        return {
          mode: "fixture" as const,
          layout: req.layout,
          pages,
          summary: ordinal === 1 ? "bad citation" : "fixed citation",
        };
      },
      onAgent: async (req) => {
        if (req.role !== "reviewer") return undefined;
        reviewerCalls += 1;
        const blocking = reviewerCalls <= 1;
        // Bare JSON clean must include NO_DEFECTS (parser short-circuit); fenced JSON also works.
        const text = blocking
          ? [
              "```json",
              JSON.stringify({
                clean: false,
                defects: [
                  {
                    severity: "blocking",
                    code: "coverage_gap",
                    issue: "missing detail",
                    path: "overview.md",
                  },
                ],
                summary: "blocking",
              }),
              "```",
            ].join("\n")
          : JSON.stringify({ clean: true, defects: [], summary: "NO_DEFECTS" });
        return { role: "reviewer", mode: "fixture", summary: text };
      },
    });

    const result = await produceWiki({
      runId: "run-budget-split",
      workspace: {
        ...workspace,
        // Single seat so one blocking reviewer call == one council round.
        orchestration: { ...workspace.orchestration, reviewCouncilSize: 1 },
      },
      layout,
      spec,
      runtime,
    });

    assert.equal(result.status, "ready_for_publish", result.summary);
    assert.equal(result.metrics.hardValidateRepairRounds, 1, "one pre-council HV repair");
    assert.equal(result.metrics.repairRounds, 1, "one council repair");
    assert.ok(writeOrdinal >= 3, `root write + HV repair + council repair, got ${writeOrdinal}`);
  });
});

describe("produceWiki research orchestration", () => {
  it("transient domain failure does not L2-retry (L0 already retried)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-retry-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-retry");

    let domainCalls = 0;
    const retrySpanIds: string[] = [];
    const runtime = createFixtureProduceRuntime({
      failAgent: (req) => {
        if (req.role !== "domain") return undefined;
        domainCalls += 1;
        if (req.spanId?.includes("@retry")) retrySpanIds.push(req.spanId);
        return "429 rate limit exceeded";
      },
    });

    const result = await produceWiki({
      runId: "run-retry",
      workspace,
      layout,
      spec: defaultWikiRunSpec(workspace.name),
      runtime,
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /429 rate limit/);
    assert.equal(domainCalls, 1, "L2 must not open a new session for transient");
    assert.deepEqual(retrySpanIds, []);
  });

  it("unknown domain failure fails without L2 default-retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-retry-fail-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-retry-fail");

    let domainCalls = 0;
    const runtime = createFixtureProduceRuntime({
      failAgent: (req) => {
        if (req.role !== "domain") return undefined;
        domainCalls += 1;
        return "boom domain reduce";
      },
    });

    const result = await produceWiki({
      runId: "run-retry-fail",
      workspace,
      layout,
      spec: defaultWikiRunSpec(workspace.name),
      runtime,
    });

    assert.equal(result.status, "failed");
    assert.match(result.summary, /boom domain reduce/);
    assert.equal(domainCalls, 1, "unknown class fails closed with no L2 retry");
  });

  it("domain units run in parallel bounded by domainConcurrency", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-produce-parallel-"));
    temps.push(root);
    const { workspace } = await makeWorkspace(root);
    const { layout } = await makeRunLayout(root, "run-parallel");

    const base = defaultWikiRunSpec(workspace.name);
    const spec: WikiRunSpec = {
      ...base,
      // Three leafless domains: each unit goes straight to its domain agent.
      domains: [
        { ...base.domains[0]!, questions: [] },
        { id: "aux-one", title: "Aux One", scope: "aux one", critical: false, questions: [] },
        { id: "aux-two", title: "Aux Two", scope: "aux two", critical: false, questions: [] },
      ],
    };

    let active = 0;
    let maxActive = 0;
    const runtime = createFixtureProduceRuntime({
      onAgent: async (req) => {
        if (req.role !== "domain") return undefined;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        return undefined;
      },
    });

    const result = await produceWiki({
      runId: "run-parallel",
      workspace: {
        ...workspace,
        orchestration: { ...workspace.orchestration, domainConcurrency: 2 },
      },
      layout,
      spec,
      runtime,
    });

    assert.equal(result.status, "ready_for_publish", result.summary);
    assert.equal(result.metrics.domainStarts, 3);
    assert.equal(maxActive, 2, "domain units must overlap up to domainConcurrency");
  });
});

/** Staging wiki with one overview citation (for hard-validate repair tests). */
async function writeCitationWiki(wikiDir: string, citation: string): Promise<string[]> {
  await mkdir(wikiDir, { recursive: true });
  const overview = [
    "---",
    "type: Overview",
    'title: "Citation test"',
    "---",
    "",
    "# Citation test",
    "",
    `Grounding: ${citation}.`,
    "",
  ].join("\n");
  const index = ["# Citation test", "", "* [Overview](overview.md)", ""].join("\n");
  await writeFile(path.join(wikiDir, "overview.md"), overview, "utf8");
  await writeFile(path.join(wikiDir, "index.md"), index, "utf8");
  return ["index.md", "overview.md"];
}
