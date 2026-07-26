import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defaultWikiRunSpec, WorkspaceConfigSchema } from "@okf-wiki/contract";
import { registerRunRecord, runWorkDir } from "@okf-wiki/core";
import { commitSpec } from "../produce/living-spec.js";
import { writeFixtureWiki } from "../produce/wiki-pages.js";
import { createFixtureProduceRuntime } from "../runtime/produce-runtime.js";
import { runWorkdirLayout } from "../runtime/workdir.js";
import {
  createWikiRepairTool,
  layoutForExistingRun,
  WIKI_REPAIR_TOOL_NAME,
  type WikiRepairToolDetails,
} from "./wiki-repair.js";

const temps: string[] = [];
after(async () => {
  for (const t of temps) await rm(t, { recursive: true, force: true });
});

async function seedRun(
  root: string,
  runId: string,
  recordStatus: "running" | "failed" | "published" = "failed",
) {
  const source = path.join(root, "source");
  const skill = path.join(root, "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(source, "README.md"), "# Src\n", "utf8");
  await writeFile(path.join(skill, "SKILL.md"), "# Skill\n", "utf8");

  const workspace = WorkspaceConfigSchema.parse({
    version: 1,
    id: "ws",
    name: "Repair WS",
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
  await commitSpec(root, runId, spec);
  const layout = runWorkdirLayout(work, new Map([["main", mount]]));
  await writeFixtureWiki(layout, "Repair WS");

  return { workspace, layout, spec };
}

describe("wiki_repair tool", () => {
  it("factory registers wiki_repair name and guidelines", () => {
    const tool = createWikiRepairTool({
      workspace: WorkspaceConfigSchema.parse({
        version: 1,
        id: "ws",
        name: "X",
        rootPath: "/tmp",
        sources: [{ id: "main", path: "/tmp/s", applyDefaultIgnores: true, ignore: [] }],
        skillPath: "/tmp/skill",
        model: { id: "openai/test" },
        publicationPath: "/tmp/out",
        limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
        planConfirm: false,
        wikiLanguage: "en",
        createdAt: new Date().toISOString(),
      }),
      sessionId: "s",
      fixture: true,
    });
    assert.equal(tool.name, WIKI_REPAIR_TOOL_NAME);
    assert.ok(
      tool.promptGuidelines?.some((g) => /wiki_repair|bash/i.test(g)),
      "guidelines mention wiki_repair / no bash",
    );
  });

  it("execute repairs existing run staging with fixture runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-repair-"));
    temps.push(root);
    const runId = "run-repair-1";
    const { workspace } = await seedRun(root, runId);

    const tool = createWikiRepairTool({
      workspace,
      sessionId: "sess-1",
      fixture: true,
      runtime: createFixtureProduceRuntime(),
    });

    type ExecuteRepair = (
      toolCallId: string,
      input: { runId: string; notes?: string },
      signal?: AbortSignal,
      onUpdate?: (u: { details?: WikiRepairToolDetails }) => void,
    ) => Promise<{ details: WikiRepairToolDetails; content: unknown[] }>;
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-1", { runId, notes: "fix overview grounding" });

    assert.equal(result.details.status, "repaired");
    assert.equal(result.details.runId, runId);
    assert.ok((result.details.pages?.length ?? 0) >= 1);
    assert.match(String(result.details.summary), /fixture|Repair|wrote|pages/i);
  });

  it("execute fails when runId missing on disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-repair-miss-"));
    temps.push(root);
    const { workspace } = await seedRun(root, "run-exists");

    const tool = createWikiRepairTool({
      workspace,
      sessionId: "sess-1",
      fixture: true,
      runtime: createFixtureProduceRuntime(),
    });

    type ExecuteRepair = (
      toolCallId: string,
      input: { runId: string; notes?: string },
    ) => Promise<{ details: WikiRepairToolDetails }>;
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-2", { runId: "no-such-run" });
    assert.equal(result.details.status, "failed");
    assert.match(String(result.details.summary), /not found/i);
  });

  it("execute rejects a run owned by another Operator Session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-repair-owner-"));
    temps.push(root);
    const runId = "run-owned";
    const { workspace } = await seedRun(root, runId);

    const tool = createWikiRepairTool({
      workspace,
      sessionId: "sess-other",
      fixture: true,
      runtime: createFixtureProduceRuntime(),
    });

    type ExecuteRepair = (
      toolCallId: string,
      input: { runId: string; notes?: string },
    ) => Promise<{ details: WikiRepairToolDetails }>;
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-owner", { runId });
    assert.equal(result.details.status, "failed");
    assert.match(String(result.details.summary), /belongs to Operator Session/i);
  });

  it("execute rejects a still-active run (pending gates own the staging tree)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-repair-active-"));
    temps.push(root);
    const runId = "run-active";
    const { workspace } = await seedRun(root, runId, "running");

    const tool = createWikiRepairTool({
      workspace,
      sessionId: "sess-1",
      fixture: true,
      runtime: createFixtureProduceRuntime(),
    });

    type ExecuteRepair = (
      toolCallId: string,
      input: { runId: string; notes?: string },
    ) => Promise<{ details: WikiRepairToolDetails }>;
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-active", { runId });
    assert.equal(result.details.status, "failed");
    assert.match(String(result.details.summary), /still active/i);
  });

  it("layoutForExistingRun rebuilds mounts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "okf-repair-layout-"));
    temps.push(root);
    const runId = "run-layout";
    await seedRun(root, runId);
    const layout = await layoutForExistingRun(root, runId);
    assert.ok(layout.sourceMounts.has("main"));
    assert.equal(layout.wikiDir, path.join(runWorkDir(root, runId), "wiki"));
  });
});
