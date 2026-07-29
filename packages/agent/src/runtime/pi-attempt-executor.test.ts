import assert from "node:assert/strict";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultWikiRunSpec, type PiAttemptInput, PiAttemptInputSchema } from "@okf-wiki/contract";
import { createFixtureProduceRuntime } from "./fixture-runner.js";
import { createPiAttemptExecutor } from "./pi-attempt-executor.js";

const digest = "a".repeat(64);
const timestamp = "2026-07-28T00:00:00.000Z";

async function fixture(node: PiAttemptInput["node"]): Promise<PiAttemptInput> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-pi-attempt-"));
  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(sources, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  return PiAttemptInputSchema.parse({
    runId: "run-1",
    attemptId: "attempt-1",
    node,
    inputDigest: digest,
    workspace: {
      id: "workspace-1",
      name: "Demo",
      rootPath: root,
      sources: [
        {
          id: "main",
          path: sources,
          applyDefaultIgnores: true,
          ignore: [],
          origin: { type: "path" },
        },
      ],
      model: { id: "fixture/model" },
      publicationPath: path.join(root, "published"),
      createdAt: timestamp,
    },
    sealedInputs: [
      {
        role: "sources",
        artifact: { artifactId: "sources", kind: "snapshot_set", digest, sealedAt: timestamp },
        readOnlyPath: sources,
      },
      {
        role: "skill",
        artifact: { artifactId: "skill", kind: "skill", digest, sealedAt: timestamp },
        readOnlyPath: skill,
      },
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.json"),
    skillPath: skill,
    sourcePaths: { main: sources },
  });
}

async function unlock(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(directory, 0o755).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await unlock(child);
    else await chmod(child, 0o644).catch(() => undefined);
  }
}

async function cleanup(input: PiAttemptInput): Promise<void> {
  const root = path.dirname(path.dirname(input.attemptDir));
  await unlock(root);
  await rm(root, { recursive: true, force: true });
}

test("Pi attempt fixture plan writes an unsealed canonical spec and transcript", async (t) => {
  const input = await fixture({ key: "plan", kind: "plan", generation: 0, runIndex: 1 });
  t.after(() => cleanup(input));
  const outcome = await createPiAttemptExecutor({ fixture: true })(
    input,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;
  const spec = outcome.unsealedArtifacts.find((artifact) => artifact.role === "spec");
  assert.ok(spec);
  assert.deepEqual(JSON.parse(await readFile(spec.sourcePath, "utf8")), defaultWikiRunSpec("Demo"));
  await access(input.sessionPath);
  // Conversation-shaped JSONL (not metadata-only stub) for Node details UI.
  const transcriptLines = (await readFile(input.sessionPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(transcriptLines.length >= 2, "expected multi-row conversation transcript");
  assert.equal(transcriptLines[0]?.role, "user");
  assert.ok(
    transcriptLines.some(
      (row) =>
        row.role === "assistant" ||
        row.type === "text" ||
        (typeof row.summary === "string" && row.summary.length > 0),
    ),
    "expected assistant/text/summary content in plan transcript",
  );
  assert.equal(
    await readFile(path.join(input.workDir, "sources", "main", "README.md"), "utf8"),
    "# Demo\n",
  );
});

test("Pi attempt fixture root writer returns a private wiki tree", async (t) => {
  const input = await fixture({
    key: "write.root",
    kind: "write.root",
    generation: 0,
    runIndex: 1,
  });
  t.after(() => cleanup(input));
  const specPath = path.join(path.dirname(path.dirname(input.attemptDir)), "sealed-spec.json");
  await writeFile(specPath, `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`, "utf8");
  input.sealedInputs.push({
    role: "spec",
    artifact: { artifactId: "spec", kind: "spec", digest, sealedAt: timestamp },
    readOnlyPath: specPath,
  });
  const outcome = await createPiAttemptExecutor({ fixture: true })(
    input,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  if (outcome.type !== "succeeded") return;
  const wiki = outcome.unsealedArtifacts.find((artifact) => artifact.role === "wiki_tree");
  assert.ok(wiki);
  assert.equal(wiki.directory, true);
  await access(path.join(wiki.sourcePath, "overview.md"));
  await access(path.join(wiki.sourcePath, "index.md"));
});

test("Pi attempt fixture research.leaf and research.domain return receipts", async (t) => {
  const leaf = await fixture({
    key: "research.leaf.core.1",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
  });
  const domain = await fixture({
    key: "research.domain.core",
    kind: "research.domain",
    generation: 0,
    runIndex: 1,
  });
  t.after(() => Promise.all([cleanup(leaf), cleanup(domain)]).then(() => undefined));
  const executor = createPiAttemptExecutor({ fixture: true });
  const leafOut = await executor(leaf, new AbortController().signal);
  assert.equal(leafOut.type, "succeeded");
  if (leafOut.type === "succeeded") {
    assert.ok(leafOut.unsealedArtifacts.some((a) => a.role === "research" || a.kind === "receipt"));
  }
  const domainOut = await executor(domain, new AbortController().signal);
  assert.equal(domainOut.type, "succeeded");
});

test("Pi attempt leaf uses sealed question from node.detail (not invented Question N)", async (t) => {
  const sealedQuestion = "What are the main runtime boundaries?";
  const leaf = await fixture({
    key: "research.leaf.core.2",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      questionIndex: 2,
      question: sealedQuestion,
      scope: "runtime",
      title: "Core",
    },
  });
  t.after(() => cleanup(leaf));
  const outcome = await createPiAttemptExecutor({ fixture: true })(
    leaf,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  await access(leaf.sessionPath);
  const transcript = await readFile(leaf.sessionPath, "utf8");
  assert.ok(
    transcript.includes(sealedQuestion),
    "transcript task must include sealed question text",
  );
  assert.ok(
    !transcript.includes("Question: Question 2"),
    "must not invent placeholder Question N when sealed question exists",
  );
});

test("Pi attempt domain uses sealed questions array; repair appends feedback", async (t) => {
  const domain = await fixture({
    key: "research.domain.core",
    kind: "research.domain",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      title: "Core",
      scope: "entry points",
      questions: ["What is this repository for?", "What are the main runtime boundaries?"],
    },
  });
  t.after(() => cleanup(domain));
  const domainOut = await createPiAttemptExecutor({ fixture: true })(
    domain,
    new AbortController().signal,
  );
  assert.equal(domainOut.type, "succeeded");
  const domainTranscript = await readFile(domain.sessionPath, "utf8");
  assert.ok(domainTranscript.includes("What is this repository for?"));
  assert.ok(domainTranscript.includes("What are the main runtime boundaries?"));

  const repair = await fixture({
    key: "repair",
    kind: "repair",
    generation: 1,
    runIndex: 1,
    detail: { feedback: "Fix broken citation on overview." },
  });
  t.after(() => cleanup(repair));
  const wikiRoot = path.join(path.dirname(path.dirname(repair.attemptDir)), "sealed-wiki-repair");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Demo\n---\n\n# Demo\n",
    "utf8",
  );
  const specPath = path.join(path.dirname(path.dirname(repair.attemptDir)), "sealed-spec-repair.json");
  await writeFile(specPath, `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`, "utf8");
  repair.sealedInputs.push(
    {
      role: "wiki_tree",
      artifact: { artifactId: "wiki", kind: "wiki_tree", digest, sealedAt: timestamp },
      readOnlyPath: wikiRoot,
    },
    {
      role: "spec",
      artifact: { artifactId: "spec", kind: "spec", digest, sealedAt: timestamp },
      readOnlyPath: specPath,
    },
  );
  let capturedRepairTask = "";
  const repairOut = await createPiAttemptExecutor({
    runtime: createFixtureProduceRuntime({
      onWrite: (req) => {
        capturedRepairTask = req.task ?? "";
        return undefined;
      },
    }),
  })(repair, new AbortController().signal);
  assert.equal(repairOut.type, "succeeded");
  assert.ok(
    capturedRepairTask.includes("Operator feedback: Fix broken citation on overview."),
    "repair task must include sealed feedback",
  );
  const repairTranscript = await readFile(repair.sessionPath, "utf8");
  assert.ok(
    repairTranscript.includes("Operator feedback: Fix broken citation on overview."),
    "repair transcript must include sealed feedback",
  );
});

test("Pi attempt fixture review.seat needs wiki_tree and returns seat receipt", async (t) => {
  const input = await fixture({
    key: "review.seat.grounding",
    kind: "review.seat",
    generation: 0,
    runIndex: 1,
  });
  t.after(() => cleanup(input));
  const wikiRoot = path.join(path.dirname(path.dirname(input.attemptDir)), "sealed-wiki");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Demo\n---\n\n# Demo\n\nGrounding: [S](repo:README.md#L1).\n",
    "utf8",
  );
  input.sealedInputs.push({
    role: "wiki_tree",
    artifact: { artifactId: "wiki", kind: "wiki_tree", digest, sealedAt: timestamp },
    readOnlyPath: wikiRoot,
  });
  const outcome = await createPiAttemptExecutor({ fixture: true })(
    input,
    new AbortController().signal,
  );
  assert.equal(outcome.type, "succeeded");
  if (outcome.type === "succeeded") {
    assert.ok(
      outcome.unsealedArtifacts.some((a) => a.role === "review_seat" || a.role === "transcript"),
    );
  }
});

test("Pi attempt reports cancellation and bad sealed specs as terminal failures", async (t) => {
  const cancelled = await fixture({ key: "plan", kind: "plan", generation: 0, runIndex: 1 });
  const invalidSpec = await fixture({
    key: "write.root",
    kind: "write.root",
    generation: 0,
    runIndex: 1,
  });
  t.after(() => Promise.all([cleanup(cancelled), cleanup(invalidSpec)]).then(() => undefined));
  const controller = new AbortController();
  controller.abort();
  const executor = createPiAttemptExecutor({ fixture: true });
  assert.deepEqual(await executor(cancelled, controller.signal), {
    type: "failed",
    error: "Pi attempt cancelled",
    failureClass: "cancelled",
  });

  const specPath = path.join(path.dirname(path.dirname(invalidSpec.attemptDir)), "bad-spec.json");
  await writeFile(specPath, "{}\n", "utf8");
  invalidSpec.sealedInputs.push({
    role: "spec",
    artifact: { artifactId: "bad-spec", kind: "spec", digest, sealedAt: timestamp },
    readOnlyPath: specPath,
  });
  const failed = await executor(invalidSpec, new AbortController().signal);
  assert.equal(failed.type, "failed");
  if (failed.type === "failed") assert.equal(failed.failureClass, "infrastructure");
});

function parseTranscriptJsonl(raw: string): Record<string, unknown>[] {
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("Pi attempt maps capacity and transport failures to typed failureClass", async (t) => {
  const { CapacityError } = await import("./run-scoped-agent.js");
  const capacityInput = await fixture({
    key: "research.leaf.core.1",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
  });
  const transportInput = await fixture({
    key: "research.leaf.core.2",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
  });
  t.after(() =>
    Promise.all([cleanup(capacityInput), cleanup(transportInput)]).then(() => undefined),
  );

  const capacityExecutor = createPiAttemptExecutor({
    fixture: true,
    runtime: {
      kind: "fixture",
      async runAgent() {
        throw new CapacityError("context overflow / compact-and-retry exhausted");
      },
      async runAgentsParallel() {
        return [];
      },
      async writeWiki() {
        throw new Error("not used");
      },
    },
  });
  const capacityOut = await capacityExecutor(capacityInput, new AbortController().signal);
  assert.equal(capacityOut.type, "failed");
  if (capacityOut.type === "failed") {
    assert.equal(capacityOut.failureClass, "capacity");
  }

  const transportExecutor = createPiAttemptExecutor({
    fixture: true,
    runtime: {
      kind: "fixture",
      async runAgent() {
        throw new Error("429 Too Many Requests — rate limit / overloaded");
      },
      async runAgentsParallel() {
        return [];
      },
      async writeWiki() {
        throw new Error("not used");
      },
    },
  });
  const transportOut = await transportExecutor(transportInput, new AbortController().signal);
  assert.equal(transportOut.type, "failed");
  if (transportOut.type === "failed") {
    assert.equal(
      transportOut.failureClass,
      "infrastructure",
      "transport after L0 maps to infrastructure (not capacity)",
    );
  }
});

test("Pi attempt writes a readable failure transcript on cancel and infrastructure fail", async (t) => {
  const cancelled = await fixture({ key: "plan", kind: "plan", generation: 0, runIndex: 1 });
  const invalidSpec = await fixture({
    key: "write.root",
    kind: "write.root",
    generation: 0,
    runIndex: 1,
  });
  t.after(() => Promise.all([cleanup(cancelled), cleanup(invalidSpec)]).then(() => undefined));
  const executor = createPiAttemptExecutor({ fixture: true });

  const controller = new AbortController();
  controller.abort();
  const cancelledOut = await executor(cancelled, controller.signal);
  assert.equal(cancelledOut.type, "failed");
  await access(cancelled.sessionPath);
  const cancelledRows = parseTranscriptJsonl(await readFile(cancelled.sessionPath, "utf8"));
  assert.ok(cancelledRows.some((row) => row.role === "assistant"));
  const cancelledMeta = cancelledRows.find((row) => row.mode === "failed");
  assert.ok(cancelledMeta, "expected failed meta row");
  assert.equal(cancelledMeta.failureClass, "cancelled");
  assert.equal(cancelledMeta.error, "Pi attempt cancelled");
  assert.equal(cancelledMeta.attemptId, cancelled.attemptId);
  assert.equal(cancelledMeta.node, "plan");

  const specPath = path.join(path.dirname(path.dirname(invalidSpec.attemptDir)), "bad-spec.json");
  await writeFile(specPath, "{}\n", "utf8");
  invalidSpec.sealedInputs.push({
    role: "spec",
    artifact: { artifactId: "bad-spec", kind: "spec", digest, sealedAt: timestamp },
    readOnlyPath: specPath,
  });
  const failed = await executor(invalidSpec, new AbortController().signal);
  assert.equal(failed.type, "failed");
  await access(invalidSpec.sessionPath);
  const failedRows = parseTranscriptJsonl(await readFile(invalidSpec.sessionPath, "utf8"));
  assert.ok(failedRows.some((row) => row.role === "assistant"));
  const failedMeta = failedRows.find((row) => row.mode === "failed");
  assert.ok(failedMeta, "expected failed meta row");
  assert.equal(failedMeta.failureClass, "infrastructure");
  assert.equal(typeof failedMeta.error, "string");
  assert.ok(String(failedMeta.error).length > 0);
});
