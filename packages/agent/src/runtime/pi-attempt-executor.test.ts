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
  const manifest = path.join(root, "sealed-manifest");
  const executionPlan = path.join(root, "sealed-execution-plan");
  const research = path.join(root, "sealed-research");
  const reviewSpec = path.join(root, "sealed-review-spec");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await mkdir(executionPlan, { recursive: true });
  await mkdir(research, { recursive: true });
  await writeFile(path.join(sources, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  await writeFile(
    path.join(manifest, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 2,
      intent: { mode: "generate" },
      mode: "generate",
      intentDigest: digest,
      sources: [{ id: "main" }],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(executionPlan, "execution-plan.json"),
    `${JSON.stringify({
      version: 4,
      workUnits: [],
      reviewLenses: [],
      fanOut: { domainCount: 0, leafCount: 0, maxDomainFanOut: 1, maxLeafFanOut: 1 },
      adaptation: { required: false, maxRounds: 0 },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(research, "receipt.json"),
    `${JSON.stringify({
      version: 1,
      runId: "run-1",
      nodeId: "research.leaf.core.1",
      parentId: "research.domain.core",
      attempt: 1,
      status: "complete",
      scope: "Repository entry points",
      summary: "Entry points are documented.",
      findings: ["Entry points are documented."],
      evidence: [],
      childReceipts: [],
      openQuestions: [],
    })}\n`,
    "utf8",
  );
  if (node.kind === "review.seat") {
    await mkdir(reviewSpec, { recursive: true });
    await writeFile(
      path.join(reviewSpec, "spec.json"),
      `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`,
      "utf8",
    );
  }
  const requiresExecutionPlan =
    node.kind === "research.leaf" || node.kind === "research.domain" || node.kind === "write.root";
  return PiAttemptInputSchema.parse({
    runId: "run-1",
    attemptId: "attempt-1",
    node,
    inputDigest: digest,
    workspace: {
      version: 2,
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
      {
        role: "frozen_run_manifest",
        artifact: { artifactId: "manifest", kind: "manifest", digest, sealedAt: timestamp },
        readOnlyPath: manifest,
      },
      ...(requiresExecutionPlan
        ? [
            {
              role: "execution_plan",
              artifact: {
                artifactId: "execution-plan",
                kind: "execution_plan",
                digest,
                sealedAt: timestamp,
              },
              readOnlyPath: executionPlan,
            },
          ]
        : []),
      ...(node.kind === "research.domain"
        ? [
            {
              role: "research",
              artifact: { artifactId: "research", kind: "receipt", digest, sealedAt: timestamp },
              readOnlyPath: research,
            },
          ]
        : []),
      ...(node.kind === "review.seat"
        ? [
            {
              role: "spec",
              artifact: { artifactId: "review-spec", kind: "spec", digest, sealedAt: timestamp },
              readOnlyPath: reviewSpec,
            },
          ]
        : []),
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

async function addRepairInputs(input: PiAttemptInput): Promise<void> {
  const root = path.dirname(path.dirname(input.attemptDir));
  const wikiRoot = path.join(root, "sealed-wiki-repair-input");
  const specPath = path.join(root, "sealed-spec-repair-input.json");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(path.join(wikiRoot, "overview.md"), "# Demo\n", "utf8");
  await writeFile(specPath, `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`, "utf8");
  input.sealedInputs.push(
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
  // Phase 0: executor attaches best-effort metrics (role / wall / stop / model).
  assert.ok(outcome.metrics);
  assert.equal(outcome.metrics.role, "plan");
  assert.equal(outcome.metrics.stopReason, "succeeded");
  assert.equal(typeof outcome.metrics.wallTimeMs, "number");
  assert.ok((outcome.metrics.wallTimeMs ?? -1) >= 0);
  const spec = outcome.unsealedArtifacts.find((artifact) => artifact.role === "spec");
  assert.ok(spec);
  assert.deepEqual(JSON.parse(await readFile(spec.sourcePath, "utf8")), defaultWikiRunSpec("Demo"));
  await access(input.sessionPath);
  // Ordered trace JSONL for Node details UI (not a bounded AttemptItem snapshot).
  const transcriptLines = (await readFile(input.sessionPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(transcriptLines.length >= 2, "expected multi-row attempt trace");
  assert.equal(transcriptLines[0]?.kind, "input");
  assert.equal(transcriptLines[0]?.trace, 1);
  assert.ok(
    transcriptLines.some(
      (row) =>
        row.kind === "assistant" ||
        (row.kind === "terminal" && typeof row.summary === "string" && row.summary.length > 0),
    ),
    "expected assistant or terminal evidence in plan trace",
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
  await assert.rejects(() => access(path.join(input.workDir, "analysis", "spec.json")), /ENOENT/);
});

test("Pi attempt fixture research.leaf and research.domain return full AnalysisReceipt", async (t) => {
  const leaf = await fixture({
    key: "research.leaf.core.1",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      questionIndex: 1,
      question: "What is this repository for?",
      scope: "Repository entry points",
    },
  });
  const domain = await fixture({
    key: "research.domain.core",
    kind: "research.domain",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      title: "Core",
      scope: "Repository entry points",
      questions: ["What is this repository for?"],
    },
  });
  t.after(() => Promise.all([cleanup(leaf), cleanup(domain)]).then(() => undefined));
  const executor = createPiAttemptExecutor({ fixture: true });
  const leafOut = await executor(leaf, new AbortController().signal);
  assert.equal(leafOut.type, "succeeded");
  if (leafOut.type === "succeeded") {
    assert.ok(leafOut.unsealedArtifacts.some((a) => a.role === "research" || a.kind === "receipt"));
    const receiptArt = leafOut.unsealedArtifacts.find((a) => a.role === "research");
    assert.ok(receiptArt);
    const { AnalysisReceiptSchema } = await import("@okf-wiki/contract");
    const raw = JSON.parse(await readFile(receiptArt.sourcePath, "utf8")) as unknown;
    const parsed = AnalysisReceiptSchema.parse(raw);
    assert.equal(parsed.nodeId, "research.leaf.core.1");
    assert.ok(parsed.findings.length >= 1);
    // Thin {role,summary,mode} shape must not be written.
    assert.equal((raw as { role?: string }).role, undefined);
  }
  const domainOut = await executor(domain, new AbortController().signal);
  assert.equal(domainOut.type, "succeeded");
  if (domainOut.type === "succeeded") {
    const receiptArt = domainOut.unsealedArtifacts.find((a) => a.role === "research");
    assert.ok(receiptArt);
    const { AnalysisReceiptSchema } = await import("@okf-wiki/contract");
    AnalysisReceiptSchema.parse(JSON.parse(await readFile(receiptArt.sourcePath, "utf8")));
  }
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
    key: "repair.1",
    kind: "repair",
    generation: 1,
    runIndex: 1,
    detail: {
      feedback: "Fix broken citation on overview.",
      repairRequest: {
        requestId: "repair:run-1:1",
        baselineCandidateId: "write.root",
        round: 1,
        sources: ["semantic"],
        issues: [{ kind: "semantic", message: "Fix broken citation on overview." }],
        scope: { pages: ["overview.md"], mode: "patch" },
      },
    },
  });
  t.after(() => cleanup(repair));
  const wikiRoot = path.join(path.dirname(path.dirname(repair.attemptDir)), "sealed-wiki-repair");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Demo\n---\n\n# Demo\n",
    "utf8",
  );
  const specPath = path.join(
    path.dirname(path.dirname(repair.attemptDir)),
    "sealed-spec-repair.json",
  );
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
  assert.ok(
    capturedRepairTask.includes("Repair mode:"),
    "repair task must include Repair mode instruction",
  );
  const repairTranscript = await readFile(repair.sessionPath, "utf8");
  assert.ok(
    repairTranscript.includes("Operator feedback: Fix broken citation on overview."),
    "repair transcript must include sealed feedback",
  );
});

test("Pi attempt repair with detail.repairRequest leads task with scope pages", async (t) => {
  const repairRequest = {
    requestId: "mech-repair:run-1:1",
    baselineCandidateId: "write.root",
    round: 1,
    sources: ["mechanical" as const],
    issues: [{ kind: "mechanical" as const, message: "overview.md: missing Source Citation" }],
    scope: { pages: ["overview.md", "architecture.md"], mode: "patch" as const },
  };
  const repair = await fixture({
    key: "repair.1",
    kind: "repair",
    generation: 0,
    runIndex: 1,
    detail: {
      feedback: "Hard-validate repair (round 1/1):\noverview.md: missing Source Citation",
      repairRequest,
    },
  });
  t.after(() => cleanup(repair));
  const wikiRoot = path.join(path.dirname(path.dirname(repair.attemptDir)), "sealed-wiki-rr");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Demo\n---\n\n# Demo\n",
    "utf8",
  );
  const specPath = path.join(path.dirname(path.dirname(repair.attemptDir)), "sealed-spec-rr.json");
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
  let capturedTask = "";
  const outcome = await createPiAttemptExecutor({
    runtime: createFixtureProduceRuntime({
      onWrite: (req) => {
        capturedTask = req.task ?? "";
        return undefined;
      },
    }),
  })(repair, new AbortController().signal);
  assert.equal(outcome.type, "succeeded");
  assert.ok(capturedTask.startsWith("RepairRequest:"), "RepairRequest block must lead the task");
  assert.ok(capturedTask.includes('"requestId": "mech-repair:run-1:1"'));
  assert.ok(capturedTask.includes("Repair scope pages: overview.md, architecture.md"));
  assert.ok(capturedTask.includes("Baseline candidate: write.root"));
  assert.ok(
    capturedTask.includes(
      "Only edit the listed scope pages unless a consistency fix on another page is strictly required.",
    ),
  );
  assert.ok(capturedTask.includes("Operator feedback: Hard-validate repair"));
});

test("Pi attempt repair rejects missing or invalid detail.repairRequest", async (t) => {
  const missing = await fixture({
    key: "repair.1",
    kind: "repair",
    generation: 0,
    runIndex: 1,
    detail: { feedback: "Fix the broken citation." },
  });
  const invalid = await fixture({
    key: "repair.1",
    kind: "repair",
    generation: 0,
    runIndex: 1,
    detail: {
      repairRequest: {
        requestId: "repair:run-1:1",
        baselineCandidateId: "write.root",
        round: 1,
        sources: ["semantic"],
        issues: [],
        scope: { pages: ["overview.md"], mode: "patch" },
      },
    },
  });
  t.after(() => Promise.all([cleanup(missing), cleanup(invalid)]).then(() => undefined));
  await Promise.all([addRepairInputs(missing), addRepairInputs(invalid)]);

  const missingOutcome = await createPiAttemptExecutor({ fixture: true })(
    missing,
    new AbortController().signal,
  );
  assert.equal(missingOutcome.type, "failed");
  if (missingOutcome.type === "failed") {
    assert.match(missingOutcome.error, /repair requires sealed detail\.repairRequest/);
  }

  (invalid.node.detail as { repairRequest?: unknown }).repairRequest = { requestId: "partial" };
  const invalidOutcome = await createPiAttemptExecutor({ fixture: true })(
    invalid,
    new AbortController().signal,
  );
  assert.equal(invalidOutcome.type, "failed");
});

test("Pi attempt write.root with detail.feedback uses repair-style task", async (t) => {
  const input = await fixture({
    key: "write.root",
    kind: "write.root",
    generation: 1,
    runIndex: 1,
    detail: { feedback: "Fix missing frontmatter on overview." },
  });
  t.after(() => cleanup(input));
  const root = path.dirname(path.dirname(input.attemptDir));
  const wikiRoot = path.join(root, "sealed-wiki-write-feedback");
  await mkdir(wikiRoot, { recursive: true });
  await writeFile(
    path.join(wikiRoot, "overview.md"),
    "---\ntype: Overview\ntitle: Demo\n---\n\n# Demo\n",
    "utf8",
  );
  const specPath = path.join(root, "sealed-spec-write-feedback.json");
  await writeFile(specPath, `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`, "utf8");
  input.sealedInputs.push(
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
  let capturedWriteTask = "";
  const outcome = await createPiAttemptExecutor({
    runtime: createFixtureProduceRuntime({
      onWrite: (req) => {
        capturedWriteTask = req.task ?? "";
        return undefined;
      },
    }),
  })(input, new AbortController().signal);
  assert.equal(outcome.type, "succeeded");
  assert.ok(
    capturedWriteTask.includes("Operator feedback: Fix missing frontmatter on overview."),
    "write.root feedback task must include sealed feedback",
  );
  assert.ok(
    capturedWriteTask.includes(
      "Repair mode: fix validation, citation, and frontmatter defects on the existing Staging Wiki; preserve good pages.",
    ),
    "write.root feedback task must include Repair mode instruction",
  );
  // Transcript truncates long write prompts (USER_CONTENT_MAX); feedback is first so it survives.
  const transcript = await readFile(input.sessionPath, "utf8");
  assert.ok(
    transcript.includes("Operator feedback: Fix missing frontmatter on overview."),
    "write.root feedback transcript must include sealed feedback (prefix survives truncation)",
  );
  assert.ok(
    capturedWriteTask.startsWith("Operator feedback:"),
    "feedback must lead the write task so truncated transcripts still show repair intent",
  );
});

test("Pi attempt fixture review.seat needs wiki_tree and returns seat receipt", async (t) => {
  const input = await fixture({
    key: "review.seat.grounding",
    kind: "review.seat",
    generation: 0,
    runIndex: 1,
    detail: { lens: "grounding", seatIndex: 0 },
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
  const cancelledOut = await executor(cancelled, controller.signal);
  assert.equal(cancelledOut.type, "failed");
  if (cancelledOut.type === "failed") {
    assert.equal(cancelledOut.error, "Pi attempt cancelled");
    assert.equal(cancelledOut.failureClass, "cancelled");
    // Phase 0: best-effort metrics attached even on cancel (never blocks completion).
    assert.equal(cancelledOut.metrics?.role, "plan");
    assert.equal(cancelledOut.metrics?.stopReason, "cancelled");
  }

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
    detail: {
      domainId: "core",
      questionIndex: 1,
      question: "What is this repository for?",
      scope: "Repository entry points",
    },
  });
  const transportInput = await fixture({
    key: "research.leaf.core.2",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      questionIndex: 2,
      question: "What are the main runtime boundaries?",
      scope: "Repository entry points",
    },
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
  const cancelledTerminal = cancelledRows.find((row) => row.kind === "terminal");
  assert.ok(cancelledTerminal, "expected terminal trace row");
  assert.equal(cancelledTerminal.status, "cancelled");
  assert.equal(cancelledTerminal.summary, "Pi attempt cancelled");

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
  const failedTerminal = failedRows.find((row) => row.kind === "terminal");
  assert.ok(failedTerminal, "expected terminal trace row");
  assert.equal(failedTerminal.status, "error");
  assert.equal(typeof failedTerminal.summary, "string");
  assert.ok(String(failedTerminal.summary).length > 0);
});
