import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkspaceConfigSchema } from "@okf-wiki/contract";
import { createSessionStatusTool, SESSION_STATUS_TOOL_NAME } from "./session-status.js";

describe("session_status tool", () => {
  it("reports context budget and sources without starting a run", async () => {
    const workspace = WorkspaceConfigSchema.parse({
      version: 2,
      id: "ws-status",
      name: "Status WS",
      rootPath: "/tmp/ws",
      sources: [
        {
          id: "main",
          path: "/tmp/src",
          applyDefaultIgnores: true,
          ignore: [],
          origin: { type: "path" },
        },
      ],
      model: { id: "openai/gpt-test" },
      publicationPath: "/tmp/wiki",
      limits: { requestTimeoutSeconds: 60, contextTargetTokens: 50_000 },
      planConfirm: true,
      wikiLanguage: "en",
      createdAt: new Date().toISOString(),
    });
    const tool = createSessionStatusTool({
      workspace,
      maxContextTokens: 100_000,
      contextTargetTokens: 50_000,
    });
    assert.equal(tool.name, SESSION_STATUS_TOOL_NAME);
    assert.match(tool.description, /Do NOT use this tool to produce/i);
    const result = await (
      tool.execute as unknown as (
        id: string,
        args: Record<string, never>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown,
      ) => Promise<{ content: Array<{ text?: string }>; details: Record<string, unknown> }>
    )("call-1", {}, undefined, undefined, undefined);
    const text = result.content.map((c) => c.text ?? "").join("\n");
    assert.match(text, /Context window: 100000/);
    assert.match(text, /Context target \(compaction\): 50000/);
    assert.match(text, /Sources: 1/);
    assert.equal(result.details.sourceCount, 1);
    assert.equal(result.details.planConfirm, true);
  });

  it("reports planConfirm ON by default, matching the run gate default", async () => {
    const workspace = WorkspaceConfigSchema.parse({
      version: 2,
      id: "ws-status-default",
      name: "Status WS",
      rootPath: "/tmp/ws",
      sources: [],
      model: { id: "openai/gpt-test" },
      publicationPath: "/tmp/wiki",
      createdAt: new Date().toISOString(),
    });
    // planConfirm omitted on input: the schema defaults it to true (HITL by
    // default), the run gate (requirePlanGate) engages, and session_status
    // reports the same.
    assert.equal(workspace.planConfirm, true);
    const tool = createSessionStatusTool({ workspace, maxContextTokens: 100_000 });
    const result = await (
      tool.execute as unknown as (
        id: string,
        args: Record<string, never>,
      ) => Promise<{ details: Record<string, unknown> }>
    )("call-2", {});
    assert.equal(result.details.planConfirm, true);
  });
});
