import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { modelRefForRole, resolveModelSelection } from "./role-model.js";

function baseWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    version: 1,
    id: "ws1",
    name: "Test",
    rootPath: "/tmp/ws",
    sources: [],
    model: { id: "openai/default", profileId: "default" },
    publicationPath: "/tmp/wiki",
    limits: {
      requestTimeoutSeconds: 120,
      retry: {
        enabled: true,
        maxRetries: 2,
        baseDelayMs: 2000,
        provider: { maxRetries: 0, maxRetryDelayMs: 60_000 },
      },
    },
    roleModels: { reviewers: [] },
    orchestration: {
      maxDepth: 2,
      maxDomainFanOut: 4,
      maxLeafFanOut: 6,
      reviewCouncilSize: 3,
      planScoutCount: 2,
      domainConcurrency: 2,
      leafConcurrency: 2,
    },
    planConfirm: false,
    operatorTools: ["read", "grep", "find", "ls"],
    wikiLanguage: "en",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("role-model", () => {
  it("falls back to workspace.model", () => {
    const ws = baseWorkspace();
    assert.equal(modelRefForRole(ws, "writer").profileId, "default");
    assert.equal(modelRefForRole(ws, "worker").id, "openai/default");
    // Empty reviewers list → workspace default model (not missing).
    assert.equal(modelRefForRole(ws, "reviewer").profileId, "default");
    assert.equal(modelRefForRole(ws, "reviewer").id, "openai/default");
  });

  it("uses roleModels.writer then planner for writer role", () => {
    const ws = baseWorkspace({
      roleModels: {
        planner: { id: "openai/planner", profileId: "planner" },
        writer: { id: "openai/writer", profileId: "writer" },
        reviewers: [],
      },
    });
    assert.equal(modelRefForRole(ws, "writer").profileId, "writer");
    assert.equal(modelRefForRole(ws, "planner").profileId, "planner");
  });

  it("writer falls back to planner when writer unset", () => {
    const ws = baseWorkspace({
      roleModels: {
        planner: { id: "openai/planner", profileId: "planner" },
        reviewers: [],
      },
    });
    assert.equal(modelRefForRole(ws, "writer").profileId, "planner");
  });

  it("overrideProfileId wins for run-time selection", () => {
    const ws = baseWorkspace({
      roleModels: {
        writer: { id: "openai/writer", profileId: "writer" },
        reviewers: [],
      },
    });
    const sel = resolveModelSelection({
      workspace: ws,
      role: "writer",
      overrideProfileId: "fast-local",
    });
    assert.equal(sel.profileId, "fast-local");
    assert.equal(sel.overridden, true);
    assert.equal(sel.role, "writer");
  });

  it("rotates roleModels.reviewers by seatIndex", () => {
    const ws = baseWorkspace({
      roleModels: {
        reviewers: [
          { id: "openai/r1", profileId: "r1" },
          { id: "openai/r2", profileId: "r2" },
        ],
      },
    });
    assert.equal(modelRefForRole(ws, "reviewer", { seatIndex: 0 }).profileId, "r1");
    assert.equal(modelRefForRole(ws, "reviewer", { seatIndex: 1 }).profileId, "r2");
    assert.equal(modelRefForRole(ws, "reviewer", { seatIndex: 2 }).profileId, "r1");
    assert.equal(
      resolveModelSelection({ workspace: ws, role: "reviewer", seatIndex: 1 }).profileId,
      "r2",
    );
  });
});
