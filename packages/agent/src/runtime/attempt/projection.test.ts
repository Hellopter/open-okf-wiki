/**
 * Attempt projection: sealed semantic inputs under inputs/, loaders, formatters.
 */

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
import { type PiAttemptInput, PiAttemptInputSchema } from "@okf-wiki/contract/pi-attempt";
import { AnalysisReceiptSchema, defaultWikiRunSpec } from "@okf-wiki/contract/wiki-runs";
import { runWorkdirLayout } from "../workdir.js";
import { materializeInputs } from "./mount.js";
import {
  formatEvidenceIndex,
  formatOperatorInputNotes,
  loadEvidenceBundle,
  mergeOperatorNotes,
} from "./projection.js";
import { readSpec } from "./shared.js";

const digest = "b".repeat(64);
const timestamp = "2026-07-30T00:00:00.000Z";

async function baseFixture(
  extras: PiAttemptInput["sealedInputs"] = [],
  node: PiAttemptInput["node"] = {
    key: "write.root",
    kind: "write.root",
    generation: 0,
    runIndex: 1,
  },
): Promise<PiAttemptInput> {
  const root = await mkdtemp(path.join(tmpdir(), "okf-projection-"));
  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const spec = path.join(root, "sealed-spec");
  const executionPlan = path.join(root, "sealed-execution-plan");
  const manifest = path.join(root, "sealed-manifest");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(spec, { recursive: true });
  await mkdir(executionPlan, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await writeFile(path.join(sources, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  const extraRoles = new Set(extras.map((extra) => extra.role));
  if (!extraRoles.has("spec")) {
    await writeFile(
      path.join(spec, "spec.json"),
      `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`,
      "utf8",
    );
  }
  if (!extraRoles.has("execution_plan")) {
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
  }
  if (!extraRoles.has("frozen_run_manifest")) {
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
  }
  return PiAttemptInputSchema.parse({
    runId: "run-proj-1",
    attemptId: "attempt-1",
    node,
    inputDigest: digest,
    workspace: {
      version: 3,
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
      orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
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
      ...(!extraRoles.has("spec")
        ? [
            {
              role: "spec",
              artifact: { artifactId: "spec", kind: "spec", digest, sealedAt: timestamp },
              readOnlyPath: spec,
            },
          ]
        : []),
      ...(!extraRoles.has("execution_plan")
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
      ...(!extraRoles.has("frozen_run_manifest")
        ? [
            {
              role: "frozen_run_manifest",
              artifact: { artifactId: "manifest", kind: "manifest", digest, sealedAt: timestamp },
              readOnlyPath: manifest,
            },
          ]
        : []),
      ...extras,
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
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

test("materialize projects spec + research receipts into inputs/evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-seal-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const specDir = path.join(root, "sealed-spec");
  await mkdir(specDir, { recursive: true });
  await writeFile(
    path.join(specDir, "spec.json"),
    `${JSON.stringify(defaultWikiRunSpec("Demo"))}\n`,
    "utf8",
  );

  const receipt = AnalysisReceiptSchema.parse({
    version: 1,
    runId: "run-proj-1",
    nodeId: "research.leaf.core.1",
    parentId: "research.domain.core",
    attempt: 1,
    status: "complete",
    scope: "core",
    summary: "Entry points live in src/main.ts",
    findings: ["Entry points live in src/main.ts"],
    evidence: [{ repositoryId: "main", path: "src/main.ts", startLine: 1, endLine: 10 }],
    childReceipts: [],
    openQuestions: [],
  });
  const receiptDir = path.join(root, "sealed-receipt");
  await mkdir(receiptDir, { recursive: true });
  await writeFile(path.join(receiptDir, "leaf.json"), `${JSON.stringify(receipt)}\n`, "utf8");
  await writeFile(
    path.join(receiptDir, ".okf-artifact-manifest.json"),
    '{"schema":1,"files":[]}\n',
    "utf8",
  );

  const input = await baseFixture([
    {
      role: "spec",
      artifact: { artifactId: "spec-1", kind: "spec", digest, sealedAt: timestamp },
      readOnlyPath: specDir,
    },
    {
      role: "research.leaf.core.1:research",
      artifact: { artifactId: "receipt-1", kind: "receipt", digest, sealedAt: timestamp },
      readOnlyPath: receiptDir,
    },
  ]);
  t.after(() => cleanup(input));

  const layout = await materializeInputs(input);

  const specProjected = path.join(layout.runWorkDir, "inputs", "spec.json");
  await access(specProjected);
  assert.equal(
    JSON.parse(await readFile(specProjected, "utf8")).summary,
    defaultWikiRunSpec("Demo").summary,
  );
  assert.equal((await readSpec(layout)).summary, defaultWikiRunSpec("Demo").summary);
  await assert.rejects(() => access(path.join(layout.analysisDir, "spec.json")), /ENOENT/);

  const indexPath = path.join(layout.runWorkDir, "inputs", "evidence", "index.json");
  await access(indexPath);
  const bundle = await loadEvidenceBundle(layout);
  assert.ok(bundle);
  assert.equal(bundle.receipts.length, 1);
  assert.equal(bundle.receipts[0]?.nodeId, "research.leaf.core.1");
  assert.ok(bundle.receipts[0]?.path.includes("inputs/evidence/receipts/"));
  await access(path.join(layout.runWorkDir, bundle.receipts[0]!.path));
  await assert.rejects(
    () => access(path.join(layout.analysisDir, "research.leaf.core.1.json")),
    /ENOENT/,
  );

  const indexText = formatEvidenceIndex(bundle);
  assert.ok(indexText.includes("research.leaf.core.1"));
  assert.ok(indexText.includes("findings=1"));
});

test("readSpec requires inputs/spec.json instead of an analysis fallback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-projected-spec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = runWorkdirLayout(path.join(root, "work"), new Map());
  await mkdir(layout.analysisDir, { recursive: true });
  await writeFile(
    path.join(layout.analysisDir, "spec.json"),
    `${JSON.stringify(defaultWikiRunSpec("Analysis only"))}\n`,
    "utf8",
  );

  await assert.rejects(() => readSpec(layout), /projected inputs\/spec\.json is unreadable/);
});

test("mergeOperatorNotes prefers sealed answer over focus", () => {
  assert.equal(mergeOperatorNotes({}), undefined);
  assert.equal(mergeOperatorNotes({ focus: "  only focus  " }), "only focus");
  assert.equal(
    mergeOperatorNotes({ operatorAnswer: "Audience is SRE" }),
    "Operator answer (authoritative):\nAudience is SRE",
  );
  const both = mergeOperatorNotes({
    focus: "Keep overview short",
    operatorAnswer: "Audience is platform engineers",
  });
  assert.match(both ?? "", /Audience is platform engineers/);
  assert.match(both ?? "", /Keep overview short/);
  assert.match(both ?? "", /Operator answer \(authoritative\)/);
  assert.equal(formatOperatorInputNotes(undefined), undefined);
  assert.match(
    formatOperatorInputNotes({ answer: "Use monorepo layout" }) ?? "",
    /Use monorepo layout/,
  );
});

test("materialize projects prior_spec into inputs/prior-spec.json", async (t) => {
  // Plan node does not take sealed `spec`/`execution_plan` — hand-build envelope.
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-prior-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const manifest = path.join(root, "sealed-manifest");
  const priorDir = path.join(root, "sealed-prior-spec");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await mkdir(priorDir, { recursive: true });
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
  const priorSpec = defaultWikiRunSpec("Prior");
  priorSpec.summary = "Prior plan summary";
  await writeFile(path.join(priorDir, "spec.json"), `${JSON.stringify(priorSpec)}\n`, "utf8");

  const input = PiAttemptInputSchema.parse({
    runId: "run-prior-1",
    attemptId: "attempt-1",
    node: { key: "plan", kind: "plan", generation: 1, runIndex: 1 },
    inputDigest: digest,
    workspace: {
      version: 3,
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
      orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
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
      {
        role: "prior_spec",
        artifact: { artifactId: "prior-1", kind: "spec", digest, sealedAt: timestamp },
        readOnlyPath: priorDir,
      },
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: skill,
    sourcePaths: { main: sources },
  });
  const layout = await materializeInputs(input);
  const projected = path.join(layout.runWorkDir, "inputs", "prior-spec.json");
  await access(projected);
  const body = JSON.parse(await readFile(projected, "utf8")) as { summary?: string };
  assert.equal(body.summary, "Prior plan summary");
  // Unlock read-only mounts before after-hook rm (inputs/evidence are 0555).
  await unlock(root);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test("materialize projects operator_input into inputs/operator-input.json", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-op-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const opDir = path.join(root, "sealed-operator-input");
  await mkdir(opDir, { recursive: true });
  await writeFile(
    path.join(opDir, "operator-input.json"),
    `${JSON.stringify({
      version: 2,
      kind: "operator_input",
      answer: "Platform engineers",
      gateId: "gate-1",
      parentAttemptId: "attempt-parent",
    })}\n`,
    "utf8",
  );

  const input = await baseFixture([
    {
      role: "operator_input",
      artifact: {
        artifactId: "op-1",
        kind: "operator_input",
        digest,
        sealedAt: timestamp,
      },
      readOnlyPath: opDir,
    },
  ]);
  t.after(() => cleanup(input));

  const layout = await materializeInputs(input);
  const projected = path.join(layout.runWorkDir, "inputs", "operator-input.json");
  await access(projected);
  const body = JSON.parse(await readFile(projected, "utf8")) as { answer?: string };
  assert.equal(body.answer, "Platform engineers");
});

test("materialize must NOT place session.jsonl or transcript under inputs/", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-tx-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const transcriptDir = path.join(root, "sealed-transcript");
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(path.join(transcriptDir, "session.jsonl"), '{"role":"user"}\n', "utf8");

  const input = await baseFixture([
    {
      role: "transcript",
      artifact: { artifactId: "tx-1", kind: "transcript", digest, sealedAt: timestamp },
      readOnlyPath: transcriptDir,
    },
  ]);
  t.after(() => cleanup(input));

  const layout = await materializeInputs(input);
  const inputsDir = path.join(layout.runWorkDir, "inputs");
  await access(inputsDir);

  async function collectFiles(dir: string, acc: string[] = []): Promise<string[]> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await collectFiles(child, acc);
      else acc.push(path.relative(inputsDir, child));
    }
    return acc;
  }
  const files = await collectFiles(inputsDir);
  assert.ok(!files.some((f) => f.includes("session") || f.includes("transcript")));
  assert.ok(!files.some((f) => f.endsWith(".jsonl")));
});

test("materialize refresh seeds wiki from prior_wiki and fails without it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const priorWiki = path.join(root, "prior-wiki");
  await mkdir(priorWiki, { recursive: true });
  await writeFile(
    path.join(priorWiki, "overview.md"),
    "---\ntype: Overview\ntitle: Prior\n---\n\n# Prior\n",
    "utf8",
  );

  const manifestDir = path.join(root, "manifest");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    path.join(manifestDir, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 2,
      intent: { mode: "refresh" },
      mode: "refresh",
      intentDigest: "c".repeat(64),
      sources: [{ id: "main" }],
    })}\n`,
    "utf8",
  );

  const withPrior = await baseFixture([
    {
      role: "frozen_run_manifest",
      artifact: { artifactId: "man-1", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: manifestDir,
    },
    {
      role: "prior_wiki",
      artifact: { artifactId: "wiki-1", kind: "wiki_tree", digest, sealedAt: timestamp },
      readOnlyPath: priorWiki,
    },
  ]);
  t.after(() => cleanup(withPrior));

  const layout = await materializeInputs(withPrior);
  await access(path.join(layout.runWorkDir, "inputs", "prior-wiki", "overview.md"));
  await access(path.join(layout.wikiDir, "overview.md"));
  await access(path.join(layout.runWorkDir, "inputs", "intent.json"));
  const intent = JSON.parse(
    await readFile(path.join(layout.runWorkDir, "inputs", "intent.json"), "utf8"),
  );
  assert.equal(intent.mode, "refresh");

  // Fail closed without prior wiki.
  const noPrior = await baseFixture([
    {
      role: "frozen_run_manifest",
      artifact: { artifactId: "man-2", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: manifestDir,
    },
  ]);
  t.after(() => cleanup(noPrior));
  await assert.rejects(
    () => materializeInputs(noPrior),
    /refresh mode requires a sealed prior_wiki/,
  );
});

test("materialize lineage: research artifact digests land in evidence index", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const receiptDir = path.join(root, "receipt");
  await mkdir(receiptDir, { recursive: true });
  const receipt = AnalysisReceiptSchema.parse({
    version: 1,
    runId: "run-proj-1",
    nodeId: "research.domain.core",
    parentId: null,
    attempt: 1,
    status: "complete",
    scope: "core",
    summary: "Domain summary",
    findings: ["Domain summary"],
    evidence: [],
    childReceipts: ["research.leaf.core.1"],
    openQuestions: [],
  });
  await writeFile(path.join(receiptDir, "domain.json"), `${JSON.stringify(receipt)}\n`, "utf8");

  const researchDigest = "d".repeat(64);
  const input = await baseFixture([
    {
      role: "research",
      artifact: {
        artifactId: "art-domain",
        kind: "receipt",
        digest: researchDigest,
        sealedAt: timestamp,
      },
      readOnlyPath: receiptDir,
    },
  ]);
  t.after(() => cleanup(input));

  const layout = await materializeInputs(input);
  const bundle = await loadEvidenceBundle(layout);
  assert.ok(bundle);
  assert.equal(bundle.receipts[0]?.digest, researchDigest);
  assert.equal(bundle.receipts[0]?.handle, "art-domain");
  // Readable under workDir
  const body = await readFile(path.join(layout.runWorkDir, bundle.receipts[0]!.path), "utf8");
  assert.ok(body.includes("Domain summary"));
});

test("materialize accepts freeze-shaped coverage_plan (requiredUnits + host extras)", async (t) => {
  // Freeze seals plan with lightPath/reasons/maxSurfacesRequired; strict schema rejects those.
  const root = await mkdtemp(path.join(tmpdir(), "okf-proj-cov-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sources = path.join(root, "sealed-sources");
  const skill = path.join(root, "sealed-skill");
  const manifest = path.join(root, "sealed-manifest");
  const planDir = path.join(root, "sealed-coverage-plan");
  const invDir = path.join(root, "sealed-coverage-inventory");
  const attemptDir = path.join(root, "attempts", "attempt-1");
  await mkdir(sources, { recursive: true });
  await mkdir(skill, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await mkdir(planDir, { recursive: true });
  await mkdir(invDir, { recursive: true });
  await writeFile(path.join(sources, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");
  await writeFile(
    path.join(manifest, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 2,
      intent: { mode: "generate" },
      mode: "generate",
      intentDigest: digest,
      sources: [{ id: "api" }, { id: "web" }],
    })}\n`,
    "utf8",
  );
  const freezePlan = {
    version: 1,
    requiredUnits: [
      { id: "api", kind: "source", sourceId: "api" },
      { id: "web", kind: "source", sourceId: "web" },
    ],
    cancelled: [],
    lightPath: false,
    reasons: ["multi-source: each source unit required"],
    maxSurfacesRequired: 12,
  };
  const freezeInventory = {
    version: 1,
    sources: [
      {
        sourceId: "api",
        fileCount: 3,
        languages: ["ts"],
        multiEntry: false,
        truncated: false,
        surfaces: [{ id: "api::.", path: ".", origin: "root" }],
      },
      {
        sourceId: "web",
        fileCount: 2,
        languages: ["ts"],
        multiEntry: false,
        truncated: false,
        surfaces: [{ id: "web::.", path: ".", origin: "root" }],
      },
    ],
    units: [
      { id: "api", kind: "source", sourceId: "api" },
      { id: "web", kind: "source", sourceId: "web" },
    ],
    sourceCount: 2,
    fileCount: 5,
    languages: ["ts"],
    multiEntry: false,
    large: true,
  };
  await writeFile(
    path.join(planDir, "coverage-plan.json"),
    `${JSON.stringify(freezePlan)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(invDir, "coverage-inventory.json"),
    `${JSON.stringify(freezeInventory)}\n`,
    "utf8",
  );

  const input = PiAttemptInputSchema.parse({
    runId: "run-cov-1",
    attemptId: "attempt-1",
    node: { key: "plan", kind: "plan", generation: 0, runIndex: 1 },
    inputDigest: digest,
    workspace: {
      version: 3,
      id: "workspace-1",
      name: "Demo",
      rootPath: root,
      sources: [
        {
          id: "api",
          path: sources,
          applyDefaultIgnores: true,
          ignore: [],
          origin: { type: "path" },
        },
        {
          id: "web",
          path: sources,
          applyDefaultIgnores: true,
          ignore: [],
          origin: { type: "path" },
        },
      ],
      model: { id: "fixture/model" },
      publicationPath: path.join(root, "published"),
      orchestration: { maxActiveRuns: 2, maxConcurrentAttempts: 4 },
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
      {
        role: "coverage_plan",
        artifact: { artifactId: "cov-plan", kind: "receipt", digest, sealedAt: timestamp },
        readOnlyPath: planDir,
      },
      {
        role: "coverage_inventory",
        artifact: { artifactId: "cov-inv", kind: "receipt", digest, sealedAt: timestamp },
        readOnlyPath: invDir,
      },
    ],
    attemptDir,
    workDir: path.join(attemptDir, "work"),
    sessionPath: path.join(attemptDir, "session.jsonl"),
    skillPath: skill,
    sourcePaths: { api: sources, web: sources },
  });

  const layout = await materializeInputs(input);
  const projectedPlan = path.join(layout.runWorkDir, "inputs", "coverage-plan.json");
  const projectedInv = path.join(layout.runWorkDir, "inputs", "coverage-inventory.json");
  await access(projectedPlan);
  await access(projectedInv);
  const planBody = JSON.parse(await readFile(projectedPlan, "utf8")) as {
    requiredUnits?: { id: string }[];
    lightPath?: boolean;
  };
  assert.deepEqual(
    planBody.requiredUnits?.map((u) => u.id),
    ["api", "web"],
  );
  // Sealed bytes projected as-is (host extras retained on disk).
  assert.equal(planBody.lightPath, false);
  await unlock(root);
  t.after(() => rm(root, { recursive: true, force: true }));
});
