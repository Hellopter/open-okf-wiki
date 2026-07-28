import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec, WorkspaceConfigSchema } from "@okf-wiki/contract";
import { registerRunRecord, runWorkDir } from "@okf-wiki/core";
import { defaultSpecStore } from "../ports/core-spec-store.js";
import { writeFixtureWiki } from "../produce/wiki-pages.js";
import { createFixtureProduceRuntime } from "../runtime/produce-runtime.js";
import { runWorkdirLayout } from "../runtime/workdir.js";
import { repairWikiGuarded } from "./repair-guarded.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

type SeedStatus = "running" | "failed" | "published" | "awaiting_plan" | "awaiting_publication";

async function seedRun(root: string, runId: string, recordStatus: SeedStatus = "failed") {
  const source = path.join(root, "source");
  const skill = path.join(root, "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(source, "README.md"), "# Src\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");

  const workspace = WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws",
    name: "Repair Guarded WS",
    rootPath: root,
    sources: [{ id: "main", path: source, applyDefaultIgnores: true, ignore: [] }],
    skillPath: skill,
    model: { id: "openai/test" },
    publicationPath: path.join(root, "out"),
    limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
    planConfirm: false,
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
  });

  const work = runWorkDir(root, runId);
  const mount = path.join(work, "sources", "main");
  await mkdir(mount, { recursive: true });
  await mkdir(path.join(work, "skill"), { recursive: true });
  await mkdir(path.join(work, "wiki"), { recursive: true });
  await mkdir(path.join(work, "analysis"), { recursive: true });
  await writeFile(path.join(mount, "README.md"), "# Frozen\n", "utf8");
  await writeFile(path.join(work, "skill", "SKILL.md"), "# Skill\n", "utf8");

  await registerRunRecord(root, workspace.id, {
    runId,
    sessionId: "sess-1",
    autoApprove: true,
    skillPath: path.join(work, "skill"),
    skillDigest: "a".repeat(64),
    sources: [{ id: "main", revision: "b".repeat(40), effectiveIgnores: [] }],
    status: recordStatus,
  });
  const spec = defaultWikiRunSpec(workspace.name);
  await defaultSpecStore.commitSpec(root, runId, spec);
  const layout = runWorkdirLayout(work, new Map([["main", mount]]));
  await writeFixtureWiki(layout, "Repair Guarded WS");

  return { workspace, layout, spec };
}

describe("repairWikiGuarded", () => {
  it("rejects wrong sessionId (ownership)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-rg-owner-"));
    temps.push(root);
    const runId = "run-owner";
    const { workspace } = await seedRun(root, runId);

    const result = await repairWikiGuarded({
      runId,
      workspace,
      sessionId: "sess-other",
      runtime: createFixtureProduceRuntime(),
      defectNotes: "fix grounding",
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.isError, true);
    assert.match(result.summary, /belongs to Operator Session/i);
  });

  it("rejects active run status (running / awaiting_plan / awaiting_publication)", async () => {
    for (const status of ["running", "awaiting_plan", "awaiting_publication"] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `okf-rg-active-${status}-`));
      temps.push(root);
      const runId = `run-${status}`;
      const { workspace } = await seedRun(root, runId, status);

      const result = await repairWikiGuarded({
        runId,
        workspace,
        sessionId: "sess-1",
        runtime: createFixtureProduceRuntime(),
        defectNotes: "fix grounding",
      });

      assert.equal(result.status, "failed", status);
      if (result.status !== "failed") continue;
      assert.equal(result.isError, true, status);
      assert.match(result.summary, /still active/i, status);
      assert.match(result.summary, new RegExp(status), status);
    }
  });

  it("concurrent lock: second call while first held fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-rg-lock-"));
    temps.push(root);
    const runId = "run-lock";
    const { workspace } = await seedRun(root, runId);

    let releaseWrite!: () => void;
    const holdWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let firstWriteStarted = false;
    let notifyStarted!: () => void;
    const firstWriteStartedP = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });

    const runtime = createFixtureProduceRuntime({
      onWrite: async () => {
        if (!firstWriteStarted) {
          firstWriteStarted = true;
          notifyStarted();
          await holdWrite;
        }
        return undefined;
      },
    });

    const firstPromise = repairWikiGuarded({
      runId,
      workspace,
      sessionId: "sess-1",
      runtime,
      defectNotes: "hold lock",
    });

    await firstWriteStartedP;

    const second = await repairWikiGuarded({
      runId,
      workspace,
      sessionId: "sess-1",
      runtime: createFixtureProduceRuntime(),
      defectNotes: "should be locked",
    });

    assert.equal(second.status, "failed");
    if (second.status === "failed") {
      assert.equal(second.isError, true);
      assert.match(second.summary, /already in progress/i);
    }

    releaseWrite();
    const first = await firstPromise;
    assert.equal(first.status, "repaired");
  });

  it("missing run fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-rg-miss-"));
    temps.push(root);
    const { workspace } = await seedRun(root, "run-exists");

    const result = await repairWikiGuarded({
      runId: "no-such-run",
      workspace,
      sessionId: "sess-1",
      runtime: createFixtureProduceRuntime(),
      defectNotes: "fix",
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.isError, false);
    assert.match(result.summary, /not found/i);
  });
});
