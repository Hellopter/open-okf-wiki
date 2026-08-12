import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiPublicationStore } from "../dist/publication-store.js";

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

  const journal = await store.publish("run-1", { policyHash: "policy" });
  assert.equal(journal.state, "committed");
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "new\n");
  assert.equal(JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "published.json"), "utf8")).policyHash, "policy");
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
  await store.publish("refresh");

  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "refreshed\n");
  assert.equal(await readFile(path.join(workspace, "wiki", "retained.md"), "utf8"), "retained\n");
});

test("fork copies a live candidate and can recover a candidate from its matching publication", async (t) => {
  const { workspace, store } = await fixture(t);
  const source = await store.prepareCandidate("source");
  await writeFile(path.join(source, "draft.md"), "source candidate\n", "utf8");
  assert.equal(await store.copyCandidate("source", "fork-live"), true);
  assert.equal(await readFile(path.join(store.candidateWikiDirectory("fork-live"), "draft.md"), "utf8"), "source candidate\n");

  await store.publish("source");
  assert.equal(await store.copyCandidate("source", "fork-published"), true);
  assert.equal(await readFile(path.join(store.candidateWikiDirectory("fork-published"), "draft.md"), "utf8"), "source candidate\n");
  assert.equal(await store.copyCandidate("different-run", "fork-untrusted"), false);
  assert.equal(await readFile(path.join(workspace, "wiki", "draft.md"), "utf8"), "source candidate\n");
});

test("writer attempts isolate unaccepted bytes and atomically promote sealed bytes", async (t) => {
  const { store } = await fixture(t);
  const candidate = await store.prepareCandidate("writer-run", "refresh");
  await mkdir(path.join(candidate, "domain"), { recursive: true });
  await writeFile(path.join(candidate, "domain", "page.md"), "accepted-old\n");

  const working = await store.prepareWriterAttempt("writer-run", "writer-node", 1, "domain/page.md");
  assert.equal(await readFile(path.join(working, "domain", "page.md"), "utf8"), "accepted-old\n");
  await writeFile(path.join(working, "domain", "page.md"), "sealed\n");
  const sealed = await store.sealWriterPage("writer-run", "writer-node", 1, "domain/page.md");
  await writeFile(path.join(working, "domain", "page.md"), "late-invalid\n");
  assert.equal(await readFile(path.join(candidate, "domain", "page.md"), "utf8"), "accepted-old\n");
  assert.equal(await readFile(path.join(sealed.wikiRoot, "domain", "page.md"), "utf8"), "sealed\n");

  await store.promoteWriterPage("writer-run", "writer-node", 1, "domain/page.md");
  assert.equal(await readFile(path.join(candidate, "domain", "page.md"), "utf8"), "sealed\n");

  const failed = await store.prepareWriterAttempt("writer-run", "writer-node", 2, "domain/page.md");
  await writeFile(path.join(failed, "domain", "page.md"), "failed-attempt\n");
  await store.discardWriterAttempt("writer-run", "writer-node", 2);
  assert.equal(await readFile(path.join(candidate, "domain", "page.md"), "utf8"), "sealed\n");
});

test("concurrent writer attempts on one page reject stale promotion without overwriting", async (t) => {
  const { store } = await fixture(t);
  const candidate = await store.prepareCandidate("writer-cas", "refresh");
  await mkdir(path.join(candidate, "domain"), { recursive: true });
  const candidatePage = path.join(candidate, "domain", "page.md");
  await writeFile(candidatePage, "baseline\n");

  const first = await store.prepareWriterAttempt("writer-cas", "writer-one", 1, "domain/page.md");
  const second = await store.prepareWriterAttempt("writer-cas", "writer-two", 1, "domain/page.md");
  await writeFile(path.join(first, "domain", "page.md"), "first\n");
  await writeFile(path.join(second, "domain", "page.md"), "second\n");
  await store.sealWriterPage("writer-cas", "writer-one", 1, "domain/page.md");
  await store.sealWriterPage("writer-cas", "writer-two", 1, "domain/page.md");

  await store.promoteWriterPage("writer-cas", "writer-one", 1, "domain/page.md");
  await assert.rejects(
    store.promoteWriterPage("writer-cas", "writer-two", 1, "domain/page.md"),
    /changed after attempt preparation/,
  );
  assert.equal(await readFile(candidatePage, "utf8"), "first\n");
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
    await assert.rejects(store.publish(`run-${interruptedAfter}`), new RegExp(`interrupt-${interruptedAfter}`));

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

  await assert.rejects(store.publish("install-failure"), { code: "ENOENT" });
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
  assert.equal((await store.readJournal("install-failure")).state, "rolled_back");
});

test("recoverPending finds journaled runs and committed recovery is idempotent", async (t) => {
  const { workspace, store } = await fixture(t, (step) => {
    if (step === "installed") throw new Error("interrupt");
  });
  const candidate = await store.prepareCandidate("pending");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  await assert.rejects(store.publish("pending"), /interrupt/);

  const recoveryStore = createWikiPublicationStore({ workspace });
  assert.deepEqual(await recoveryStore.recoverPending(), [{ runId: "pending", outcome: "committed" }]);
  assert.deepEqual(await recoveryStore.recover("pending"), { runId: "pending", outcome: "committed" });
});
