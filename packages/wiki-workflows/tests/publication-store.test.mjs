import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiPublicationStore } from "../dist/publication-store.js";

const finalSpec = {
  version: 1,
  overview: { pageType: "overview", path: "overview.md", title: "Overview", purpose: "Repository map", readerQuestions: [], requiredFacets: [], findingIds: [] },
  domains: [{ id: "core", title: "Core", purpose: "Core", pages: [
    { pageType: "domain", path: "core/domain.md", title: "Core", purpose: "Core", readerQuestions: [], requiredFacets: [], findingIds: [] },
  ] }],
  crossLinks: [], sharedTerms: [], omissions: [],
};

async function fixture(t, afterStep) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-publish-"));
  t.after(async () => await rm(workspace, { recursive: true, force: true }));
  const wiki = path.join(workspace, "wiki");
  await mkdir(path.join(wiki, "assets"), { recursive: true });
  await writeFile(path.join(wiki, "overview.md"), "old\n", "utf8");
  await writeFile(path.join(wiki, "assets", "logo.png"), "asset", "utf8");
  return { workspace, store: createWikiPublicationStore({ workspace, afterStep }) };
}

test("candidate is isolated from published Wiki and preserves only non-Markdown assets", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.prepareCandidate("run-1");
  await assert.rejects(readFile(path.join(candidate, "overview.md"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(candidate, "assets", "logo.png"), "utf8"), "asset");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");

  const journal = await store.publish("run-1", { wikiSpec: finalSpec, policyHash: "policy" });
  assert.equal(journal.state, "committed");
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "new\n");
  assert.equal(JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "published.json"), "utf8")).policyHash, "policy");
});

test("published metadata carries a validated final WikiSpec and is loadable for refresh", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.prepareCandidate("with-spec");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  await store.publish("with-spec", { wikiSpec: finalSpec, policyHash: "policy" });
  const resumed = await createWikiPublicationStore({ workspace }).readPublishedMetadata();
  assert.deepEqual(resumed.wikiSpec, finalSpec);
  assert.equal(resumed.policyHash, "policy");

  const invalid = structuredClone(finalSpec);
  invalid.domains[0].pages[0].path = "wrong/domain.md";
  const second = await createWikiPublicationStore({ workspace }).prepareCandidate("invalid-spec", "refresh");
  await writeFile(path.join(second, "overview.md"), "changed\n");
  await assert.rejects(createWikiPublicationStore({ workspace }).publish("invalid-spec", { wikiSpec: invalid }), /core\/domain.md/);
});

test("published metadata fails closed when WikiSpec is absent", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.prepareCandidate("missing-spec");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  await assert.rejects(store.publish("missing-spec", {}), /WikiSpec must be an object/);

  await mkdir(path.join(workspace, ".okf-wiki"), { recursive: true });
  await writeFile(path.join(workspace, ".okf-wiki", "published.json"), JSON.stringify({
    version: 1, runId: "old", publishedAt: "2026-08-14T00:00:00.000Z",
  }));
  await assert.rejects(store.readPublishedMetadata(), /WikiSpec must be an object/);
});

test("ensureCandidate resumes files from an interrupted run without resetting them", async (t) => {
  const { store } = await fixture(t);
  const candidate = await store.prepareCandidate("resume");
  await writeFile(path.join(candidate, "draft.md"), "in progress\n", "utf8");
  assert.equal(await store.ensureCandidate("resume"), candidate);
  assert.equal(await readFile(path.join(candidate, "draft.md"), "utf8"), "in progress\n");
});

test("refresh seeds retained Markdown through candidate validation and publication", async (t) => {
  const { workspace, store } = await fixture(t);
  await writeFile(path.join(workspace, "wiki", "retained.md"), "retained\n", "utf8");
  const candidate = await store.prepareCandidate("refresh", "refresh");
  assert.equal(await readFile(path.join(candidate, "retained.md"), "utf8"), "retained\n");
  assert.equal(await readFile(path.join(candidate, "overview.md"), "utf8"), "old\n");

  // Represents validation reading the complete unpublished page set before publish.
  const candidatePages = await Promise.all(["overview.md", "retained.md"].map(async (page) => await readFile(path.join(candidate, page), "utf8")));
  assert.deepEqual(candidatePages, ["old\n", "retained\n"]);
  await writeFile(path.join(candidate, "overview.md"), "refreshed\n", "utf8");
  await store.publish("refresh", { wikiSpec: finalSpec });

  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "refreshed\n");
  assert.equal(await readFile(path.join(workspace, "wiki", "retained.md"), "utf8"), "retained\n");
});

for (const interruptedAfter of ["prepared", "backed_up", "installed"]) {
  test(`publish recovery is deterministic after interruption at ${interruptedAfter}`, async (t) => {
    let injected = false;
    const { workspace, store } = await fixture(t, (step) => {
      if (step === interruptedAfter && !injected) {
        injected = true;
        throw new Error(`interrupt-${step}`);
      }
    });
    const candidate = await store.prepareCandidate(`run-${interruptedAfter}`);
    await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
    await assert.rejects(store.publish(`run-${interruptedAfter}`, { wikiSpec: finalSpec }), new RegExp(`interrupt-${interruptedAfter}`));

    const recoveryStore = createWikiPublicationStore({ workspace });
    const recovery = await recoveryStore.recover(`run-${interruptedAfter}`);
    if (interruptedAfter === "installed") {
      assert.equal(recovery.outcome, "committed");
      assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "new\n");
    } else {
      assert.equal(recovery.outcome, "rolled_back");
      assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
    }
  });
}

test("ordinary install failure restores the previous Wiki before publish rejects", async (t) => {
  let candidate;
  const { workspace, store } = await fixture(t, async (step) => {
    if (step === "backed_up") await rm(candidate, { recursive: true, force: true });
  });
  candidate = await store.prepareCandidate("install-failure");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");

  await assert.rejects(store.publish("install-failure", { wikiSpec: finalSpec }), { code: "ENOENT" });
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
  assert.equal((await store.readJournal("install-failure")).state, "rolled_back");
});

test("recoverPending finds journaled runs and committed recovery is idempotent", async (t) => {
  const { workspace, store } = await fixture(t, (step) => {
    if (step === "installed") throw new Error("interrupt");
  });
  const candidate = await store.prepareCandidate("pending");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  await assert.rejects(store.publish("pending", { wikiSpec: finalSpec }), /interrupt/);

  const recoveryStore = createWikiPublicationStore({ workspace });
  assert.deepEqual(await recoveryStore.recoverPending(), [{ runId: "pending", outcome: "committed" }]);
  assert.deepEqual(await recoveryStore.recover("pending"), { runId: "pending", outcome: "committed" });
});
