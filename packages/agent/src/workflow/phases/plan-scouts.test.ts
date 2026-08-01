import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { WorkspaceOrchestration } from "@okf-wiki/contract";
import { type AgentRunRequest, createFixtureProduceRuntime } from "../../runtime/fixture-runner.js";
import { runWorkdirLayout } from "../../runtime/workdir.js";
import { runPlanScouts } from "./plan-scouts.js";

const temps: string[] = [];

after(async () => {
  for (const t of temps) {
    await rm(t, { recursive: true, force: true });
  }
});

async function makeLayout(root: string) {
  const runWorkDir = path.join(root, "run");
  const source = path.join(runWorkDir, "sources", "main");
  await mkdir(source, { recursive: true });
  await mkdir(path.join(runWorkDir, "analysis"), { recursive: true });
  return runWorkdirLayout(runWorkDir, new Map([["main", source]]));
}

const orch = (partial: Partial<WorkspaceOrchestration> = {}): WorkspaceOrchestration => ({
  maxDomainFanOut: 4,
  maxLeafFanOut: 6,
  reviewCouncilSize: 3,
  planScoutCount: 2,
  domainConcurrency: 2,
  leafConcurrency: 2,
  ...partial,
  maxActiveRuns: partial.maxActiveRuns ?? 2,
  maxConcurrentAttempts: partial.maxConcurrentAttempts ?? 4,
});

describe("runPlanScouts", () => {
  it("skips when planScoutCount is 0", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-0-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime: createFixtureProduceRuntime(),
      orch: orch({ planScoutCount: 0 }),
    });
    assert.equal(result.receipts.length, 0);
    assert.equal(result.plannerContext, "");
  });

  it("skips on fixture runtime even when count > 0", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-fix-"));
    temps.push(root);
    const layout = await makeLayout(root);
    // Fixture kind short-circuits before agent calls (cheap plan path).
    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime: createFixtureProduceRuntime(),
      orch: orch({ planScoutCount: 2 }),
    });
    assert.equal(result.receipts.length, 0);
  });

  it("writes scout receipts and planner context on live-shaped runner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-scout-live-"));
    temps.push(root);
    const layout = await makeLayout(root);
    const roles: string[] = [];
    // Override kind to live so scouts execute; still use fixture agent bodies.
    const base = createFixtureProduceRuntime({
      onAgent: async (req: AgentRunRequest) => {
        roles.push(req.role);
        return {
          role: req.role,
          summary: `scout body for ${req.spanId}`,
          mode: "fixture",
        };
      },
    });
    const runtime = {
      ...base,
      kind: "live" as const,
    };

    const result = await runPlanScouts({
      layout,
      workspaceName: "Demo",
      runtime,
      orch: orch({ planScoutCount: 2, planScoutConcurrency: 2 }),
    });

    assert.equal(result.receipts.length, 2);
    assert.ok(result.receipts.every((r) => r.ok));
    assert.match(result.plannerContext, /Plan scout receipts/);
    assert.match(result.plannerContext, /entry|layout/);
    assert.ok(roles.every((r) => r === "root_research"));

    const entryPath = path.join(layout.runWorkDir, "analysis/plan-scouts/entry.md");
    const body = await readFile(entryPath, "utf8");
    assert.match(body, /Plan scout: entry/);
  });
});
