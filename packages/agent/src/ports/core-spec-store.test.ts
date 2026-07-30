import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { defaultSpecStore, planDraftPathFromRunWorkDir } from "./core-spec-store.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

describe("core-spec-store", () => {
  it("writePlanDraft / readPlanDraft / clearPlanDraft path-first handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-plan-draft-"));
    temps.push(root);
    const spec = defaultWikiRunSpec("Draft");
    const file = await defaultSpecStore.writePlanDraft(root, spec);
    assert.equal(file, planDraftPathFromRunWorkDir(root));
    const loaded = await defaultSpecStore.readPlanDraft(root);
    assert.equal(loaded?.summary, spec.summary);
    const raw = await readFile(file, "utf8");
    assert.match(raw, /overview\.md/);

    await defaultSpecStore.clearPlanDraft(root);
    assert.equal(await defaultSpecStore.readPlanDraft(root), null);
  });
});
