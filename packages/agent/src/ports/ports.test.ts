/**
 * Unit tests for port interfaces with in-memory fakes (no disk, no Pi).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AnalysisReceipt,
  defaultWikiRunSpec,
  type RunGraphSnapshot,
  type WikiRunSpec,
} from "@okf-wiki/contract";
import type { WikiWriteRequest, WikiWriteResult } from "./agent-runner.js";
import type { GatePort } from "./gate-port.js";
import type { GraphStore } from "./graph-store.js";
import type {
  AttachReceiptInput,
  PersistReceiptInput,
  ReceiptListItem,
  ReceiptStore,
  ResearchChildResult,
} from "./receipt-store.js";
import type { SpecStore } from "./spec-store.js";
import type { WikiWriter } from "./wiki-writer.js";

function memoryReceiptStore(): ReceiptStore {
  const byKey = new Map<string, AnalysisReceipt>();
  const key = (root: string, runId: string, nodeId: string) => `${root}|${runId}|${nodeId}`;

  return {
    async write(input: PersistReceiptInput) {
      const receipt: AnalysisReceipt = {
        version: 1,
        runId: input.runId,
        nodeId: input.nodeId,
        parentId: input.parentId,
        attempt: 1,
        status: input.status ?? "complete",
        scope: input.scope,
        summary: input.summary,
        findings: [input.summary.slice(0, 100)],
        evidence: [],
        childReceipts: input.childReceipts ?? [],
        openQuestions: input.openQuestions ?? [],
      };
      byKey.set(key(input.workspaceRoot, input.runId, input.nodeId), receipt);
      const relativePath = `analysis/receipts/${input.nodeId}.json`;
      return {
        receiptPath: `/mem/${input.runId}/${input.nodeId}.json`,
        relativePath,
        receipt,
      };
    },
    async attach(child: ResearchChildResult, input: AttachReceiptInput) {
      const persisted = await this.write({
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        nodeId: input.nodeId,
        parentId: input.parentId,
        scope: input.scope,
        summary: input.summary ?? child.summary,
        status: input.status,
        childReceipts: input.childReceipts,
        openQuestions: input.openQuestions,
      });
      return {
        ...child,
        summary: input.summary ?? child.summary,
        receiptPath: persisted.relativePath,
        absoluteReceiptPath: persisted.receiptPath,
      };
    },
    async buildIndex(workspaceRoot: string, runId: string) {
      const items = await this.list(workspaceRoot, runId);
      if (items.length === 0) return "No analysis receipts found under analysis/receipts/.";
      return items.map((i) => `- ${i.relativePath} [${i.status}]`).join("\n");
    },
    async list(workspaceRoot: string, runId: string): Promise<ReceiptListItem[]> {
      const prefix = `${workspaceRoot}|${runId}|`;
      const out: ReceiptListItem[] = [];
      for (const [k, r] of byKey) {
        if (!k.startsWith(prefix)) continue;
        out.push({
          relativePath: `analysis/receipts/${r.nodeId}.json`,
          status: r.status,
          scope: r.scope,
          summary: r.summary,
        });
      }
      return out;
    },
  };
}

function memorySpecStore(): SpecStore {
  const committed = new Map<string, WikiRunSpec>();
  const drafts = new Map<string, WikiRunSpec>();
  return {
    async commitSpec(workspaceRoot, runId, spec) {
      committed.set(`${workspaceRoot}|${runId}`, spec);
      return `/mem/${runId}/spec.json`;
    },
    async readCommittedSpec(workspaceRoot, runId) {
      return committed.get(`${workspaceRoot}|${runId}`) ?? null;
    },
    async writePlanDraft(runWorkDir, spec) {
      drafts.set(runWorkDir, spec);
      return `${runWorkDir}/analysis/plan-draft.json`;
    },
    async readPlanDraft(runWorkDir) {
      return drafts.get(runWorkDir) ?? null;
    },
  };
}

function memoryGraphStore(): GraphStore {
  const graphs = new Map<string, RunGraphSnapshot>();
  return {
    async save(runId, snapshot) {
      graphs.set(runId, snapshot);
    },
    async load(runId) {
      return graphs.get(runId) ?? null;
    },
  };
}

describe("ports memory fakes", () => {
  it("ReceiptStore write/attach/buildIndex/list round-trip", async () => {
    const store = memoryReceiptStore();
    const written = await store.write({
      workspaceRoot: "/ws",
      runId: "r1",
      nodeId: "domain-a",
      parentId: "root",
      scope: "core",
      summary: "found entrypoints",
    });
    assert.equal(written.relativePath, "analysis/receipts/domain-a.json");

    const attached = await store.attach(
      { role: "leaf", mode: "fixture", summary: "leaf summary" },
      {
        workspaceRoot: "/ws",
        runId: "r1",
        nodeId: "leaf-1",
        parentId: "domain-a",
        scope: "q1",
      },
    );
    assert.equal(attached.receiptPath, "analysis/receipts/leaf-1.json");

    const list = await store.list("/ws", "r1");
    assert.equal(list.length, 2);
    const index = await store.buildIndex("/ws", "r1");
    assert.match(index, /domain-a/);
    assert.match(index, /leaf-1/);
  });

  it("SpecStore commit/read and plan-draft handoff", async () => {
    const store = memorySpecStore();
    const spec = defaultWikiRunSpec("Demo");
    await store.writePlanDraft("/run", spec);
    const draft = await store.readPlanDraft("/run");
    assert.equal(draft?.summary, spec.summary);

    await store.commitSpec("/ws", "run-1", spec);
    const committed = await store.readCommittedSpec("/ws", "run-1");
    assert.equal(committed?.pages[0]?.path, "overview.md");
    assert.equal(await store.readCommittedSpec("/ws", "missing"), null);
  });

  it("GatePort waitForDecision returns decision", async () => {
    const gate: GatePort = {
      async waitForDecision(request) {
        return { action: "approve", spec: request.spec };
      },
    };
    const decision = await gate.waitForDecision({
      toolCallId: "t1",
      runId: "r1",
      gate: "plan",
      spec: defaultWikiRunSpec("G"),
      pages: [],
    });
    assert.equal(decision.action, "approve");
  });

  it("GraphStore save/load", async () => {
    const store = memoryGraphStore();
    const snap: RunGraphSnapshot = {
      topology: [],
      topologyVersion: 1,
      attempts: [],
    };
    await store.save("run-x", snap);
    assert.deepEqual(await store.load("run-x"), snap);
    assert.equal(await store.load("missing"), null);
  });

  it("WikiWriter is satisfied by writeWiki-only object", async () => {
    const writer: WikiWriter = {
      async writeWiki(_input: WikiWriteRequest): Promise<WikiWriteResult> {
        return {
          mode: "fixture",
          layout: _input.layout,
          pages: ["overview.md"],
          summary: "ok",
        };
      },
    };
    const result = await writer.writeWiki({
      layout: {
        runWorkDir: "/r",
        sourcesDir: "/r/sources",
        skillDir: "/r/skill",
        wikiDir: "/r/wiki",
        analysisDir: "/r/analysis",
        sourceMounts: new Map(),
      },
      spec: defaultWikiRunSpec("W"),
      workspaceName: "W",
      task: "write",
    });
    assert.deepEqual(result.pages, ["overview.md"]);
  });
});
