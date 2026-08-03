import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { type WorkspaceConfig, WorkspaceLimitsSchema, WorkspaceOrchestrationSchema, WorkspaceRoleModelsSchema } from "@okf-wiki/contract/workspace";
import { WorkspaceIntakeError } from "./workspace-errors.js";
import { applyWorkspacePatch } from "./workspace-patch.js";

function baseWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: 3,
    id: "ws-1",
    name: "Demo",
    rootPath: "/tmp/ws",
    sources: [],
    model: { id: "openai/default" },
    publicationPath: "/tmp/ws/wiki",
    limits: WorkspaceLimitsSchema.parse({}),
    roleModels: WorkspaceRoleModelsSchema.parse({}),
    orchestration: WorkspaceOrchestrationSchema.parse({
      maxActiveRuns: 2,
      maxConcurrentAttempts: 4,
    }),
    planConfirm: false,
    operatorTools: ["read", "grep", "find", "ls"],
    wikiLanguage: "en",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    revision: overrides.revision ?? 0,
  };
}

test("applyWorkspacePatch applies scalar fields and resolves paths", async () => {
  const next = await applyWorkspacePatch(
    baseWorkspace({ skillPath: "/old/skill" }),
    {
      name: "Renamed",
      publicationPath: "relative/wiki",
      planConfirm: true,
      wikiLanguage: "zh",
      skillPath: "relative/skill",
      limits: { requestTimeoutSeconds: 900 },
      operatorTools: ["bash"],
    },
    {
      resolveModelSelection: async () => {
        throw new Error("should not resolve model");
      },
    },
  );

  assert.equal(next.name, "Renamed");
  assert.equal(next.planConfirm, true);
  assert.equal(next.wikiLanguage, "zh");
  assert.equal(next.publicationPath, path.resolve("relative/wiki"));
  assert.equal(next.skillPath, path.resolve("relative/skill"));
  assert.equal(next.limits.requestTimeoutSeconds, 900);
  assert.deepEqual(next.operatorTools, ["bash"]);
  // Immutable fields
  assert.equal(next.id, "ws-1");
  assert.equal(next.rootPath, "/tmp/ws");
});

test("applyWorkspacePatch clears skillPath when null", async () => {
  const next = await applyWorkspacePatch(
    baseWorkspace({ skillPath: "/tmp/skill" }),
    { skillPath: null },
    {
      resolveModelSelection: async () => {
        throw new Error("should not resolve model");
      },
    },
  );
  assert.equal(next.skillPath, undefined);
});

test("applyWorkspacePatch resolves model via deps", async () => {
  let seen: string | undefined;
  const next = await applyWorkspacePatch(
    baseWorkspace(),
    { modelProfileId: "corp-gpt" },
    {
      resolveModelSelection: async (profileId) => {
        seen = profileId;
        return { id: "openai/gpt-4o", profileId: "corp-gpt" };
      },
    },
  );
  assert.equal(seen, "corp-gpt");
  assert.deepEqual(next.model, { id: "openai/gpt-4o", profileId: "corp-gpt" });
});

test("applyWorkspacePatch accepts model.profileId carrier", async () => {
  const next = await applyWorkspacePatch(
    baseWorkspace(),
    { model: { profileId: "alt" } },
    {
      resolveModelSelection: async (profileId) => ({ id: "m", profileId }),
    },
  );
  assert.deepEqual(next.model, { id: "m", profileId: "alt" });
});

test("applyWorkspacePatch rejects model selection without profile id", async () => {
  await assert.rejects(
    () =>
      applyWorkspacePatch(
        baseWorkspace(),
        // Bypass contract: force empty selection carrier.
        { model: {} as { profileId: string } },
        {
          resolveModelSelection: async () => ({ id: "x" }),
        },
      ),
    (error: unknown) =>
      error instanceof WorkspaceIntakeError && error.message.includes("modelProfileId is required"),
  );
});
