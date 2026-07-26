/**
 * Produce orchestration with a fake AgentRunner — no Pi, no live model.
 * Lives under workflow/ so ports/ stays free of pi imports (including tests).
 * Proves AgentRunner + GraphStore + ProgressSink inject together.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  defaultWikiRunSpec,
  type RunGraphSnapshot,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import { loadRunGraph, registerRunRecord, writeRunGraph } from "@okf-wiki/core";
import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  RunWorkdirLayoutPaths,
  WikiWriteRequest,
  WikiWriteResult,
} from "../ports/agent-runner.js";
import type { GraphStore } from "../ports/graph-store.js";
import { progressSinkFromCallback } from "../ports/progress-sink.js";
import type { ProduceProgress } from "../produce/progress.js";
import { writeFixtureWiki } from "../produce/wiki-pages.js";
import { AttemptJournal } from "./journal.js";
import { produceWiki } from "./produce.js";
import { runWiki } from "./run-wiki.js";
import { topologyFromSpec } from "./topology.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

/** Tiny layout builder — path joins only; no pi/ import. */
function testLayout(runWorkDir: string, sourceMounts: Map<string, string>): RunWorkdirLayoutPaths {
  return {
    runWorkDir,
    sourcesDir: path.join(runWorkDir, "sources"),
    skillDir: path.join(runWorkDir, "skill"),
    wikiDir: path.join(runWorkDir, "wiki"),
    analysisDir: path.join(runWorkDir, "analysis"),
    sourceMounts,
  };
}

/** Fake runner: records calls, writes fixture wiki, no LLM. */
function createFakeRunner(opts?: { onRun?: (req: AgentRunRequest) => void }): AgentRunner {
  return {
    kind: "fixture",
    async runAgent(input): Promise<AgentRunResult> {
      opts?.onRun?.(input);
      const attemptId = input.spanId?.trim() || input.role;
      input.onProgress?.({
        attemptId,
        nodeKey: input.nodeKey?.trim() || attemptId,
        runIndex: input.runIndex ?? 0,
        role: input.role,
        status: "done",
        summary: `fake ${input.role}`,
      });
      if (input.role === "reviewer") {
        return {
          role: "reviewer",
          mode: "fixture",
          summary: "NO_DEFECTS",
        };
      }
      return {
        role: input.role,
        mode: "fixture",
        summary: `fake ${input.role} summary`,
      };
    },
    async runAgentsParallel(tasks, _opts) {
      return Promise.all(tasks.map((t) => this.runAgent(t)));
    },
    async writeWiki(input: WikiWriteRequest): Promise<WikiWriteResult> {
      await mkdir(input.layout.wikiDir, { recursive: true });
      await mkdir(input.layout.analysisDir, { recursive: true });
      const attemptId = input.spanId?.trim() || "root_write";
      const nodeKey = input.nodeKey?.trim() || attemptId;
      const runIndex = input.runIndex ?? 0;
      const graphRole = input.graphRole ?? "root_write";
      input.onProgress?.({
        attemptId,
        nodeKey,
        runIndex,
        role: graphRole,
        status: "running",
      });
      const pages = await writeFixtureWiki(
        input.layout,
        input.spec.summary?.trim() || input.workspaceName,
      );
      input.onProgress?.({
        attemptId,
        nodeKey,
        runIndex,
        role: graphRole,
        status: "done",
        summary: "fake write",
      });
      return {
        mode: "fixture",
        layout: input.layout,
        pages,
        summary: "fake write",
      };
    },
  };
}

type MemoryGraphStore = GraphStore & {
  snapshots: Map<string, RunGraphSnapshot>;
  saveCalls: number;
};

function createMemoryGraphStore(): MemoryGraphStore {
  const snapshots = new Map<string, RunGraphSnapshot>();
  const store: MemoryGraphStore = {
    snapshots,
    saveCalls: 0,
    async save(runId, snapshot) {
      store.saveCalls += 1;
      snapshots.set(runId, {
        topologyVersion: snapshot.topologyVersion,
        topology: [...snapshot.topology],
        attempts: [...snapshot.attempts],
        ...(snapshot.playhead ? { playhead: { ...snapshot.playhead } } : {}),
      });
    },
    async load(runId) {
      return snapshots.get(runId) ?? null;
    },
  };
  return store;
}

describe("injectable AgentRunner + GraphStore + journal (no LLM)", () => {
  it("fake runner + memory store + ProgressSink: append-only journal and store.save", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-fake-runner-"));
    temps.push(root);
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "README.md"), "# x\n", "utf8");
    const skill = path.join(root, "skill");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# s\n", "utf8");
    const workspace = WorkspaceConfigSchema.parse({
      version: 1,
      id: "ws",
      name: "Fake",
      rootPath: root,
      sources: [{ id: "main", path: src, applyDefaultIgnores: true, ignore: [] }],
      skillPath: skill,
      model: { id: "openai/test" },
      publicationPath: path.join(root, "out"),
      limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
      planConfirm: false,
      wikiLanguage: "en",
      createdAt: new Date().toISOString(),
    });
    const runId = "run-fake";
    const runWorkDir = path.join(root, ".okf-wiki", "runs", runId);
    const source = path.join(runWorkDir, "sources", "main");
    await mkdir(path.join(runWorkDir, "skill"), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "# f\n", "utf8");
    await writeFile(path.join(runWorkDir, "skill", "SKILL.md"), "# s\n", "utf8");
    const layout = testLayout(runWorkDir, new Map([["main", source]]));

    const roles: string[] = [];
    const progress: ProduceProgress[] = [];
    let sinkEmits = 0;
    const sink = progressSinkFromCallback((p) => {
      sinkEmits += 1;
      progress.push(p);
    });
    const runner = createFakeRunner({
      onRun: (req) => roles.push(req.role),
    });
    const store = createMemoryGraphStore();
    const journal = new AttemptJournal();
    const spec = defaultWikiRunSpec(workspace.name);
    journal.setTopology(topologyFromSpec(spec), 1);

    // Seed one attempt before produce — must survive append-only upserts.
    const seed = journal.startAttempt({ nodeKey: "seed", role: "plan", attemptId: "seed@0" });
    journal.completeAttempt(seed.attemptId, { status: "done", summary: "seeded" });
    const seedCount = journal.snapshot().attempts.length;
    assert.equal(seedCount, 1);

    const result = await produceWiki({
      runId,
      workspace,
      layout,
      spec,
      runtime: runner,
      onProgress: (p) => {
        // Port is live: ProgressSink.emit is the fan-out boundary.
        sink.emit(p);
        if (p.kind === "attempt") journal.upsert(p.attempt);
      },
    });

    assert.equal(result.status, "ready_for_publish");
    assert.ok(roles.includes("domain") || roles.includes("leaf") || roles.includes("reviewer"));
    assert.ok(progress.some((p) => p.kind === "attempt"));
    assert.ok(sinkEmits >= 1, "ProgressSink.emit must be exercised");

    const snap = journal.snapshot();
    assert.ok(snap.topology.length > 0);
    // Append-only: seed attempt still present after produce upserts.
    assert.ok(
      snap.attempts.some((a) => a.attemptId === "seed@0"),
      "journal must retain prior attempts (append-only)",
    );
    assert.ok(
      snap.attempts.length > seedCount,
      `expected new attempts appended, seed=${seedCount} got=${snap.attempts.length}`,
    );
    const reviewAttempts = snap.attempts.filter((a) => a.role === "reviewer");
    assert.ok(reviewAttempts.length >= 1, "expected at least one reviewer attempt");
    for (const a of reviewAttempts) {
      assert.equal(a.nodeKey, "review", "reviewer attempts must attach to topology node review");
      assert.match(a.attemptId, /^review@\d+:reviewer-\d+$/);
    }
    // Happy-path fake runner has clean review → no repair rounds; root_write only.
    const rootWrites = snap.attempts.filter((a) => a.nodeKey === "root_write");
    assert.ok(rootWrites.length >= 1, "expected root_write attempt");
    assert.equal(
      snap.attempts.some((a) => a.nodeKey === "repair"),
      false,
      "clean path should not emit repair attempts",
    );

    await store.save(runId, snap);
    assert.equal(store.saveCalls, 1);
    const loaded = await store.load(runId);
    assert.ok(loaded);
    assert.ok(loaded!.attempts.length >= 2);
    assert.ok(loaded!.attempts.some((a) => a.attemptId === "seed@0"));
  });

  it("runWiki injects fake runner + memory GraphStore + ProgressSink (orchestration save)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-runwiki-ports-"));
    temps.push(root);
    const src = path.join(root, "src");
    const skill = path.join(root, "skill");
    await mkdir(src, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(src, "README.md"), "# x\n", "utf8");
    await writeFile(path.join(skill, "SKILL.md"), "# s\n", "utf8");
    const workspace = WorkspaceConfigSchema.parse({
      version: 1,
      id: "ws",
      name: "Ports",
      rootPath: root,
      sources: [{ id: "main", path: src, applyDefaultIgnores: true, ignore: [] }],
      skillPath: skill,
      model: { id: "openai/test" },
      publicationPath: path.join(root, "out"),
      limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
      planConfirm: false,
      wikiLanguage: "en",
      createdAt: new Date().toISOString(),
    });

    const roles: string[] = [];
    const progress: ProduceProgress[] = [];
    let sinkEmits = 0;
    const progressSink = progressSinkFromCallback((p) => {
      sinkEmits += 1;
      progress.push(p);
    });
    const store = createMemoryGraphStore();
    const runner = createFakeRunner({
      onRun: (req) => roles.push(req.role),
    });

    // Fake freeze: register run + write frozen layout without git/LLM.
    const freeze = async ({ sessionId }: { sessionId: string }) => {
      const runId = `run-${sessionId}`;
      const runWorkDir = path.join(root, ".okf-wiki", "runs", runId);
      const frozenSrc = path.join(runWorkDir, "sources", "main");
      const skillPath = path.join(runWorkDir, "skill");
      await mkdir(frozenSrc, { recursive: true });
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(frozenSrc, "README.md"), "# f\n", "utf8");
      await writeFile(path.join(skillPath, "SKILL.md"), "# s\n", "utf8");
      const skillDigest = "a".repeat(64);
      const revision = "b".repeat(40);
      await registerRunRecord(root, workspace.id, {
        autoApprove: true,
        skillPath,
        skillDigest,
        sessionId,
        sources: [{ id: "main", revision, effectiveIgnores: [] }],
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
            path: frozenSrc,
          },
        ],
        sourcePathMap: new Map([["main", frozenSrc]]),
        sourceIgnores: new Map([["main", []] as [string, string[]]]),
      };
    };

    const result = await runWiki({
      workspace,
      sessionId: "ports-1",
      toolCallId: "t-ports",
      autoApprove: true,
      gateCoordinator: {
        waitForDecision: async () => ({ action: "approve" as const }),
      },
      fixture: true,
      runtime: runner,
      freeze,
      publish: async () => ({ publicationPath: workspace.publicationPath!, pageCount: 2 }),
      graphStore: store,
      progressSink,
    });

    assert.equal(result.status, "published");
    assert.ok(result.runId);
    // ProgressSink was the orchestration fan-out (not dead code).
    assert.ok(sinkEmits >= 1, "ProgressSink.emit must run via runWiki");
    assert.ok(
      progress.some((p) => p.kind === "topology" || p.kind === "graph" || p.kind === "attempt"),
    );
    // GraphStore.save called by runWiki orchestration (not test-side).
    assert.ok(store.saveCalls >= 1, `expected store.save from runWiki, got ${store.saveCalls}`);
    const loaded = await store.load(result.runId!);
    assert.ok(loaded, "memory GraphStore must retain final snapshot");
    assert.ok(loaded!.topology.length >= 1);
    assert.ok(
      loaded!.attempts.length >= 1,
      `expected attempts in saved graph, got ${loaded!.attempts.length}`,
    );
    // Fake runner was used (no LLM roles still recorded by produce path).
    assert.ok(
      roles.length >= 1 || loaded!.attempts.some((a) => a.role === "plan" || a.nodeKey === "plan"),
      "expected plan or produce roles without LLM",
    );
  });

  it("core GraphStore adapter round-trips journal snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-gstore-"));
    temps.push(root);
    const runId = "run-g";
    await mkdir(path.join(root, ".okf-wiki", "runs", runId, "analysis"), { recursive: true });
    const journal = new AttemptJournal();
    journal.setTopology(topologyFromSpec(defaultWikiRunSpec("G")), 1);
    const a = journal.startAttempt({ nodeKey: "plan", role: "plan" });
    journal.completeAttempt(a.attemptId, { status: "done", summary: "ok" });
    const coreStore: GraphStore = {
      save: (id, snap) => writeRunGraph(root, id, snap).then(() => undefined),
      load: (id) => loadRunGraph(root, id),
    };
    await coreStore.save(runId, journal.snapshot());
    const loaded = await coreStore.load(runId);
    assert.ok(loaded);
    assert.equal(loaded!.attempts.length, 1);
    assert.equal(loaded!.attempts[0]?.role, "plan");
  });
});
