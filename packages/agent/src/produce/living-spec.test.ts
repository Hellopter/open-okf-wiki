import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec } from "@okf-wiki/contract";
import { commitSpec, readCommittedSpec, specPath } from "./living-spec.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

describe("living-spec", () => {
  it("commitSpec is the sole writer for analysis/spec.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-lspec-"));
    temps.push(root);
    const spec = defaultWikiRunSpec("LS");
    const file = await commitSpec(root, "run-1", spec);
    assert.equal(file, specPath(root, "run-1"));
    const raw = await readFile(file, "utf8");
    assert.match(raw, /overview\.md/);
    const loaded = await readCommittedSpec(root, "run-1");
    assert.equal(loaded?.pages[0]?.path, "overview.md");
  });
});
