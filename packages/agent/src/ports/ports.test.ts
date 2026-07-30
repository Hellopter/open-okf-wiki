/**
 * Unit tests for port interfaces with in-memory fakes (no disk, no Pi).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultWikiRunSpec, type WikiRunSpec } from "@okf-wiki/contract";
import type { SpecStore } from "./spec-store.js";

function memorySpecStore(): SpecStore {
  const drafts = new Map<string, WikiRunSpec>();
  return {
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
  it("SpecStore plan-draft handoff", async () => {
    const store = memorySpecStore();
    const spec = defaultWikiRunSpec("Demo");
    await store.writePlanDraft("/run", spec);
    const draft = await store.readPlanDraft("/run");
    assert.equal(draft?.summary, spec.summary);
  });
});
