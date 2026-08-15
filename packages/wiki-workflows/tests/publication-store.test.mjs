import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWikiPublicationStore } from "../dist/publication-store.js";
import { issueWikiPublicationSeal } from "../dist/wiki-publication-seal.js";

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

async function publish(store, runId, candidate, result = {}) {
  const seal = await issueWikiPublicationSeal({
    runId,
    executionToken: `execution-${runId}`,
    candidateRoot: candidate,
    pages: ["overview.md", "core/domain.md"],
    spec: finalSpec,
  });
  return await store.publish(runId, {
    sourceFingerprint: "source-sha256",
    summary: "complete",
    ...result,
  }, seal);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("candidate is isolated and completely empty", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.prepareCandidate("run-1");
  assert.deepEqual(await readdir(candidate), []);
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");

  const publication = await publish(store, "run-1", candidate);
  assert.equal(publication.state, "published");
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "new\n");
  const metadata = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "published.json"), "utf8"));
  assert.equal(metadata.version, 2);
  assert.equal(metadata.sourceFingerprint, "source-sha256");
  assert.equal(metadata.summary, "complete");
  assert.deepEqual(metadata.pages, ["overview.md", "core/domain.md"]);
  assert.match(metadata.finalTreeDigest, /^[a-f0-9]{64}$/);
});

test("published metadata carries a validated final WikiSpec and remains loadable provenance", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.prepareCandidate("with-spec");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  await publish(store, "with-spec", candidate);
  const resumed = await createWikiPublicationStore({ workspace }).readPublishedMetadata();
  assert.deepEqual(resumed.wikiSpec, finalSpec);
  assert.equal(resumed.version, 2);
  assert.equal(resumed.sourceFingerprint, "source-sha256");

  const metadataFile = path.join(workspace, ".okf-wiki", "published.json");
  const corrupted = JSON.parse(await readFile(metadataFile, "utf8"));
  corrupted.pages.reverse();
  await writeFile(metadataFile, JSON.stringify(corrupted));
  await assert.rejects(createWikiPublicationStore({ workspace }).readPublishedMetadata(), /pages do not match/);
  await assert.rejects(createWikiPublicationStore({ workspace }).reconcile("with-spec"), /pages do not match/);

  const invalid = structuredClone(finalSpec);
  invalid.domains[0].pages[0].path = "wrong/domain.md";
  const second = await createWikiPublicationStore({ workspace }).prepareCandidate("invalid-spec");
  await writeFile(path.join(second, "overview.md"), "changed\n");
  await assert.rejects(issueWikiPublicationSeal({
    runId: "invalid-spec", executionToken: "execution-invalid-spec", candidateRoot: second, pages: ["overview.md", "wrong/domain.md"], spec: invalid,
  }), /core\/domain.md/);
});

test("publication rejects a valid seal issued for a different Run before mutating the published Wiki", async (t) => {
  const { workspace, store } = await fixture(t);
  const candidate = await store.prepareCandidate("expected-run");
  await writeFile(path.join(candidate, "overview.md"), "new\n");
  const seal = await issueWikiPublicationSeal({
    runId: "other-run", executionToken: "execution-other-run", candidateRoot: candidate, pages: ["overview.md", "core/domain.md"], spec: finalSpec,
  });
  await assert.rejects(store.publish("expected-run", {
    sourceFingerprint: "source-sha256", summary: "complete",
  }, seal), /different run/);
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
  assert.deepEqual(await store.reconcile("expected-run"), { state: "not_published", recovery: "none" });
});

test("published metadata reader accepts v1 provenance and fails closed without WikiSpec", async (t) => {
  const { workspace, store } = await fixture(t);
  await mkdir(path.join(workspace, ".okf-wiki"), { recursive: true });
  await writeFile(path.join(workspace, ".okf-wiki", "published.json"), JSON.stringify({
    version: 1, runId: "old", publishedAt: "2026-08-14T00:00:00.000Z", wikiSpec: finalSpec, policyHash: "legacy",
  }));
  const legacy = await store.readPublishedMetadata();
  assert.equal(legacy.version, 1);
  assert.equal(legacy.policyHash, "legacy");

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

for (const interruptedAfter of ["prepared", "backed_up", "installed", "committed"]) {
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
    await assert.rejects(publish(store, `run-${interruptedAfter}`, candidate), new RegExp(`interrupt-${interruptedAfter}`));

    const recoveryStore = createWikiPublicationStore({ workspace });
    const recovery = await recoveryStore.reconcile(`run-${interruptedAfter}`);
    if (interruptedAfter === "installed" || interruptedAfter === "committed") {
      assert.equal(recovery.state, "published");
      assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "new\n");
    } else {
      assert.deepEqual(recovery, { state: "not_published", recovery: "rolled_back" });
      assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
    }
  });
}

for (const blockedAfter of ["prepared", "backed_up", "installed", "committed"]) {
  test(`a second store waits for a live publisher blocked after ${blockedAfter}`, async (t) => {
    const reached = deferred();
    const release = deferred();
    const { workspace, store } = await fixture(t, async (step) => {
      if (step === blockedAfter) {
        reached.resolve();
        await release.promise;
      }
    });
    const runId = `leased-${blockedAfter}`;
    const candidate = await store.prepareCandidate(runId);
    await writeFile(path.join(candidate, "overview.md"), `${blockedAfter}\n`);
    const publishing = publish(store, runId, candidate);
    await reached.promise;

    let reconciled = false;
    const reconciliation = createWikiPublicationStore({ workspace }).reconcile(runId)
      .then((value) => { reconciled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reconciled, false, "reconcile must wait for the live publication lease owner");
    release.resolve();
    await publishing;
    assert.equal((await reconciliation).state, "published");
  });
}

test("the publication lease blocks another process and reclaims a dead owner", async (t) => {
  const reached = deferred();
  const release = deferred();
  const { workspace, store } = await fixture(t, async (step) => {
    if (step === "prepared") {
      reached.resolve();
      await release.promise;
    }
  });
  const candidate = await store.prepareCandidate("cross-process");
  await writeFile(path.join(candidate, "overview.md"), "cross process\n");
  const publishing = publish(store, "cross-process", candidate);
  await reached.promise;

  const moduleUrl = new URL("../dist/publication-store.js", import.meta.url).href;
  const script = `
    import { createWikiPublicationStore } from ${JSON.stringify(moduleUrl)};
    process.stdout.write("started\\n");
    await createWikiPublicationStore({ workspace: ${JSON.stringify(workspace)} }).readPublishedMetadata();
    process.stdout.write("acquired\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childExit = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitFor(() => stdout.includes("started"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.doesNotMatch(stdout, /acquired/);
  release.resolve();
  await publishing;
  const [exitCode] = await childExit;
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /acquired/);

  const staleLock = path.join(workspace, ".okf-wiki", "publication.lock");
  await writeFile(staleLock, "");
  let acquiredWhileInitializing = false;
  const initializing = createWikiPublicationStore({ workspace }).readPublishedMetadata()
    .then((metadata) => { acquiredWhileInitializing = true; return metadata; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(acquiredWhileInitializing, false, "a fresh partial lease must not be reclaimed as stale");
  await writeFile(staleLock, JSON.stringify({
    version: 1, pid: 999_999_999, token: "dead-owner", acquiredAt: "2026-08-16T00:00:00.000Z",
  }));
  assert.equal((await initializing).runId, "cross-process");
  await assert.rejects(readFile(staleLock), { code: "ENOENT" });
});

test("acknowledged journals are durable audit history and never recover against later Wikis", async (t) => {
  const { workspace } = await fixture(t);
  const auditDigests = [];
  for (const runId of ["serial-1", "serial-2", "serial-3"]) {
    const store = createWikiPublicationStore({ workspace });
    const candidate = await store.prepareCandidate(runId);
    await writeFile(path.join(candidate, "overview.md"), `${runId}\n`);
    await publish(store, runId, candidate, { summary: `summary-${runId}` });
    const terminalGapRestart = createWikiPublicationStore({ workspace });
    assert.equal((await terminalGapRestart.reconcile(runId)).state, "published");
    await terminalGapRestart.acknowledge(runId);
    await terminalGapRestart.acknowledge(runId);

    const activeJournal = path.join(workspace, ".okf-wiki", "runs", runId, "publish.json");
    await assert.rejects(readFile(activeJournal), { code: "ENOENT" });
    const audit = JSON.parse(await readFile(path.join(workspace, ".okf-wiki", "publications", `${runId}.json`), "utf8"));
    assert.equal(audit.version, 2);
    assert.equal(audit.state, "committed");
    assert.equal(audit.publishedMetadata.summary, `summary-${runId}`);
    auditDigests.push(audit.metadataDigest);

    const restarted = createWikiPublicationStore({ workspace });
    await restarted.recoverPending();
    assert.equal((await restarted.readPublishedMetadata()).runId, runId);
  }
  assert.equal(new Set(auditDigests).size, 3);
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "serial-3\n");
});

test("reconcile rejects provenance and journal tampering even when page paths are unchanged", async (t) => {
  const { workspace, store } = await fixture(t);
  const runId = "metadata-integrity";
  const candidate = await store.prepareCandidate(runId);
  await writeFile(path.join(candidate, "overview.md"), "published\n");
  await publish(store, runId, candidate);
  const metadataFile = path.join(workspace, ".okf-wiki", "published.json");
  const journalFile = path.join(workspace, ".okf-wiki", "runs", runId, "publish.json");
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));

  const tamperedMetadata = [
    { ...metadata, runId: "metadata-integrity-other" },
    { ...metadata, publishedAt: "2026-08-16T01:02:03.000Z" },
    { ...metadata, sourceFingerprint: "tampered-source" },
    { ...metadata, summary: "tampered summary" },
    { ...metadata, finalTreeDigest: "0".repeat(64) },
    {
      ...metadata,
      wikiSpec: { ...metadata.wikiSpec, overview: { ...metadata.wikiSpec.overview, title: "Tampered title" } },
    },
  ];
  for (const tampered of tamperedMetadata) {
    await writeFile(metadataFile, JSON.stringify(tampered));
    await assert.rejects(createWikiPublicationStore({ workspace }).reconcile(runId), /inconsistent published provenance/);
  }

  await writeFile(metadataFile, JSON.stringify(metadata));
  const journal = JSON.parse(await readFile(journalFile, "utf8"));
  journal.publishedMetadata.summary = "journal tamper";
  await writeFile(journalFile, JSON.stringify(journal));
  await assert.rejects(createWikiPublicationStore({ workspace }).reconcile(runId), /Invalid Wiki publish journal metadata/);
});

test("ordinary install failure restores the previous Wiki before publish rejects", async (t) => {
  let candidate;
  const { workspace, store } = await fixture(t, async (step) => {
    if (step === "backed_up") await rm(candidate, { recursive: true, force: true });
  });
  candidate = await store.prepareCandidate("install-failure");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");

  await assert.rejects(publish(store, "install-failure", candidate), { code: "ENOENT" });
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
  assert.deepEqual(await store.reconcile("install-failure"), { state: "not_published", recovery: "rolled_back" });
});

test("recoverPending finds journaled runs and committed recovery is idempotent", async (t) => {
  const { workspace, store } = await fixture(t, (step) => {
    if (step === "installed") throw new Error("interrupt");
  });
  const candidate = await store.prepareCandidate("pending");
  await writeFile(path.join(candidate, "overview.md"), "new\n", "utf8");
  await assert.rejects(publish(store, "pending", candidate), /interrupt/);

  const recoveryStore = createWikiPublicationStore({ workspace });
  await recoveryStore.recoverPending();
  assert.equal((await recoveryStore.reconcile("pending")).state, "published");
});

test("reconcile projects a published terminal fact after install crashes before the Run commits", async (t) => {
  const { workspace, store } = await fixture(t, (step) => {
    if (step === "installed") throw new Error("crash-after-install");
  });
  const candidate = await store.prepareCandidate("terminal-gap");
  await writeFile(path.join(candidate, "overview.md"), "new\n");
  const seal = await issueWikiPublicationSeal({
    runId: "terminal-gap", executionToken: "execution-terminal-gap", candidateRoot: candidate, pages: ["overview.md", "core/domain.md"], spec: finalSpec,
  });
  const finalTreeDigest = seal.finalTreeDigest;
  await assert.rejects(store.publish("terminal-gap", {
    sourceFingerprint: "source-sha256", summary: "complete",
  }, seal), /crash-after-install/);

  const recoveryStore = createWikiPublicationStore({ workspace });
  assert.deepEqual(await recoveryStore.reconcile("terminal-gap"), {
    state: "published",
    runId: "terminal-gap",
    pages: ["overview.md", "core/domain.md"],
    sourceFingerprint: "source-sha256",
    finalTreeDigest,
  });
  await assert.rejects(recoveryStore.prepareCandidate("terminal-gap"), /reconcile it instead/);
  await writeFile(path.join(workspace, "wiki", "overview.md"), "externally changed\n");
  await assert.rejects(recoveryStore.reconcile("terminal-gap"), /committed publication digest/);
});

test("publish re-verifies the sealed tree immediately before install and restores the old Wiki on drift", async (t) => {
  let candidate;
  const { workspace, store } = await fixture(t, async (step) => {
    if (step === "backed_up") await writeFile(path.join(candidate, "overview.md"), "mutated\n");
  });
  candidate = await store.prepareCandidate("sealed-drift");
  await writeFile(path.join(candidate, "overview.md"), "new\n");

  await assert.rejects(publish(store, "sealed-drift", candidate), /changed after it was sealed/);
  assert.equal(await readFile(path.join(workspace, "wiki", "overview.md"), "utf8"), "old\n");
  assert.deepEqual(await store.reconcile("sealed-drift"), { state: "not_published", recovery: "rolled_back" });
});
