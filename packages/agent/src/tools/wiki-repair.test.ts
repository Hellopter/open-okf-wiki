import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceConfigSchema } from "@okf-wiki/contract";
import {
  createWikiRepairTool,
  WIKI_REPAIR_TOOL_NAME,
  type WikiRepairToolDetails,
} from "./wiki-repair.js";

function workspace() {
  return WorkspaceConfigSchema.parse({
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
  });
}

type ExecuteRepair = (
  toolCallId: string,
  input: { runId: string; notes?: string; nodeKey?: string },
  signal?: AbortSignal,
  onUpdate?: (u: { details?: WikiRepairToolDetails }) => void,
) => Promise<{ details: WikiRepairToolDetails; content: unknown[]; isError?: boolean }>;

describe("wiki_repair tool", () => {
  it("factory registers wiki_repair name and guidelines", () => {
    const tool = createWikiRepairTool({
      workspace: workspace(),
      sessionId: "s",
    });
    assert.equal(tool.name, WIKI_REPAIR_TOOL_NAME);
    assert.ok(
      tool.promptGuidelines?.some((g) => /wiki_repair|bash/i.test(g)),
      "guidelines mention wiki_repair / no bash",
    );
  });

  it("fails closed when RerunNode dispatch is not wired", async () => {
    const tool = createWikiRepairTool({
      workspace: workspace(),
      sessionId: "sess-1",
    });
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-1", { runId: "run-1" });
    assert.equal(result.details.status, "failed");
    assert.match(String(result.details.summary), /RerunNode|Run API/i);
  });

  it("dispatches RerunNode via injected port and returns accepted receipt", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createWikiRepairTool({
      workspace: workspace(),
      sessionId: "sess-1",
      resolveRepairTarget: async () => ({ nodeKey: "write.root", generation: 2 }),
      rerunWikiNode: async (input) => {
        calls.push(input);
        return {
          commandId: input.commandId,
          runId: input.runId,
          revision: 9,
          accepted: true,
        };
      },
    });
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-2", { runId: "run-repair", notes: "fix citations" });
    assert.equal(result.details.status, "accepted");
    assert.equal(result.details.runId, "run-repair");
    assert.equal(result.details.nodeKey, "write.root");
    assert.equal(result.details.generation, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.runId, "run-repair");
    assert.equal(calls[0]?.feedback, "fix citations");
    assert.equal(calls[0]?.generation, 2);
  });

  it("fails when resolveRepairTarget returns null", async () => {
    const tool = createWikiRepairTool({
      workspace: workspace(),
      sessionId: "sess-1",
      resolveRepairTarget: async () => null,
      rerunWikiNode: async () => {
        throw new Error("should not dispatch");
      },
    });
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-3", { runId: "missing" });
    assert.equal(result.details.status, "failed");
    assert.match(String(result.details.summary), /No rerunnable node/i);
  });

  it("surfaces dispatch errors as failed", async () => {
    const tool = createWikiRepairTool({
      workspace: workspace(),
      sessionId: "sess-1",
      resolveRepairTarget: async () => ({ nodeKey: "write.root", generation: 0 }),
      rerunWikiNode: async () => {
        throw new Error("generation is not current");
      },
    });
    const execute = tool.execute as unknown as ExecuteRepair;
    const result = await execute("tc-4", { runId: "run-stale" });
    assert.equal(result.details.status, "failed");
    assert.match(String(result.details.summary), /generation is not current/i);
  });
});
