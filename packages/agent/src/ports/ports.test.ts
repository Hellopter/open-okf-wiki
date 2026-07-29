/**
 * Unit tests for port interfaces with in-memory fakes (no disk, no Pi).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec, type WikiRunSpec } from "@okf-wiki/contract";
import type { SpecStore } from "./spec-store.js";

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
    async clearPlanDraft(runWorkDir) {
      drafts.delete(runWorkDir);
    },
  };
}

describe("ports memory fakes", () => {
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
});
