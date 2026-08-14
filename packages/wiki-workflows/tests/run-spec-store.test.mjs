import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiRunSpecStore } from "../dist/run-spec-store.js";

const page = (pageType, pagePath) => ({ pageType, path: pagePath, title: pagePath, purpose: "Reference", readerQuestions: [], requiredFacets: [], findingIds: [] });
const spec = () => ({
  version: 1, overview: page("overview", "overview.md"),
  domains: [{ id: "core", title: "Core", purpose: "Core", pages: [page("domain", "core/domain.md")] }],
  crossLinks: [], sharedTerms: [], omissions: [],
});

test("atomically persists, resumes, and revisions a run WikiSpec", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-run-spec-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiRunSpecStore({ workspace, now: () => "2026-08-14T00:00:00.000Z" });
  assert.equal(await store.read("run-1"), undefined);
  const first = await store.save("run-1", spec(), 0);
  assert.equal(first.revision, 1);
  assert.deepEqual((await createWikiRunSpecStore({ workspace }).read("run-1")).spec, first.spec);
  const secondSpec = spec();
  secondSpec.overview.title = "Repository overview";
  const second = await store.save("run-1", secondSpec, 1);
  assert.equal(second.revision, 2);
  await assert.rejects(store.save("run-1", spec(), 1), /revision conflict/);
  assert.equal(JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "runs", "run-1", "spec.json"), "utf8")).revision, 2);
});

test("serializes concurrent revisions and rejects invalid persisted content", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-run-spec-concurrent-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const store = createWikiRunSpecStore({ workspace });
  const revisions = await Promise.all([store.save("run-1", spec()), store.save("run-1", spec())]);
  assert.deepEqual(revisions.map(({ revision }) => revision), [1, 2]);
  await assert.rejects(store.save("../escape", spec()), /Invalid Wiki run spec identifier/);
});
