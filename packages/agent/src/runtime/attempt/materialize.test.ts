/**
 * Phase 2 materialize: project sealed spec + research into inputs/evidence,
 * transcript containment, refresh prior wiki.
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
import {
  AnalysisReceiptSchema,
  defaultWikiRunSpec,
  type PiAttemptInput,
  PiAttemptInputSchema,
} from "@okf-wiki/contract";
import { runWorkdirLayout } from "../workdir.js";
import {
  formatEvidenceIndex,
  formatOperatorInputNotes,
  loadEvidenceBundle,
  materializeInputs,
  mergeOperatorNotes,
} from "./materialize.js";
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
  const root = await mkdtemp(path.join(tmpdir(), "okf-materialize-"));
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
    runId: "run-mat-1",
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
  const root = await mkdtemp(path.join(tmpdir(), "okf-mat-seal-"));
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
    runId: "run-mat-1",
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

test("materialize rejects legacy manifest versions, role names, and filenames", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-legacy-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const v1Dir = path.join(root, "v1");
  await mkdir(v1Dir, { recursive: true });
  await writeFile(
    path.join(v1Dir, "frozen-run-manifest.json"),
    `${JSON.stringify({
      version: 1,
      intent: { mode: "generate" },
      mode: "generate",
      intentDigest: digest,
      sources: [{ id: "main" }],
    })}\n`,
    "utf8",
  );
  const v1 = await baseFixture([
    {
      role: "frozen_run_manifest",
      artifact: { artifactId: "v1", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: v1Dir,
    },
  ]);
  t.after(() => cleanup(v1));
  await assert.rejects(() => materializeInputs(v1), /sealed frozen_run_manifest is invalid/);

  const oldNameDir = path.join(root, "old-name");
  await mkdir(oldNameDir, { recursive: true });
  await writeFile(
    path.join(oldNameDir, "manifest.json"),
    `${JSON.stringify({ version: 2, intent: { mode: "generate" } })}\n`,
    "utf8",
  );
  const oldName = await baseFixture([
    {
      role: "frozen_run_manifest",
      artifact: { artifactId: "old-name", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: oldNameDir,
    },
  ]);
  t.after(() => cleanup(oldName));
  await assert.rejects(
    () => materializeInputs(oldName),
    /sealed frozen_run_manifest is unreadable/,
  );

  const legacyRole = await baseFixture([
    {
      role: "manifest",
      artifact: { artifactId: "legacy-role", kind: "manifest", digest, sealedAt: timestamp },
      readOnlyPath: oldNameDir,
    },
  ]);
  t.after(() => cleanup(legacyRole));
  await assert.rejects(
    () => materializeInputs(legacyRole),
    /sealed input role is not declared by write\.root: manifest/,
  );
});

test("materialize rejects a Pi envelope missing NodeContract-required inputs", async (t) => {
  const input = await baseFixture([], {
    key: "research.leaf.core.1",
    kind: "research.leaf",
    generation: 0,
    runIndex: 1,
    detail: {
      domainId: "core",
      question: "What is this repository for?",
      scope: "Repository entry points",
    },
  });
  t.after(() => cleanup(input));
  const index = input.sealedInputs.findIndex((sealed) => sealed.role === "execution_plan");
  assert.ok(index >= 0, "fixture must start with a valid execution plan");
  input.sealedInputs.splice(index, 1);

  await assert.rejects(
    () => materializeInputs(input),
    /research\.leaf missing required sealed input\(s\): execution_plan/,
  );
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

test("materialize projects operator_input into inputs/operator-input.json", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "okf-mat-op-"));
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
  const root = await mkdtemp(path.join(tmpdir(), "okf-mat-tx-"));
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
  const root = await mkdtemp(path.join(tmpdir(), "okf-mat-refresh-"));
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
  const root = await mkdtemp(path.join(tmpdir(), "okf-mat-lineage-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const receiptDir = path.join(root, "receipt");
  await mkdir(receiptDir, { recursive: true });
  const receipt = AnalysisReceiptSchema.parse({
    version: 1,
    runId: "run-mat-1",
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

test("mountSealedSourceTree prefers hardlink shared mount (Phase 7)", async () => {
  const { mountSealedSourceTree } = await import("./materialize.js");
  const root = await mkdtemp(path.join(tmpdir(), "okf-mount-"));
  try {
    const sealed = path.join(root, "sealed");
    const mountA = path.join(root, "attempt-a", "sources", "main");
    const mountB = path.join(root, "attempt-b", "sources", "main");
    await mkdir(path.join(sealed, "src"), { recursive: true });
    await writeFile(path.join(sealed, "src", "a.ts"), "export const a = 1;\n", "utf8");
    await writeFile(path.join(sealed, "README.md"), "# sealed\n", "utf8");
    // Make sealed read-only like freeze.
    await chmod(path.join(sealed, "src", "a.ts"), 0o444);
    await chmod(path.join(sealed, "README.md"), 0o444);

    const modeA = await mountSealedSourceTree(sealed, mountA, "sealed source main");
    const modeB = await mountSealedSourceTree(sealed, mountB, "sealed source main");
    assert.ok(modeA === "hardlink" || modeA === "copy");
    assert.ok(modeB === "hardlink" || modeB === "copy");
    // Content readable and ordinary (no symlinks).
    assert.equal(await readFile(path.join(mountA, "README.md"), "utf8"), "# sealed\n");
    assert.equal(await readFile(path.join(mountB, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    const st = await lstat(path.join(mountA, "README.md"));
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    // Hardlink shares inode with sealed when mode is hardlink.
    if (modeA === "hardlink") {
      const sealedSt = await lstat(path.join(sealed, "README.md"));
      assert.equal(st.ino, sealedSt.ino);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
