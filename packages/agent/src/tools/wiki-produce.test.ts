import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type WikiProduceToolDetails,
  WikiProduceToolDetailsSchema,
  WorkspaceConfigSchema,
} from "@okf-wiki/contract";
import { createWikiProduceTool, type StartWikiRun } from "./wiki-produce.js";

type ExecuteWikiProduce = (
  toolCallId: string,
  input: { notes?: string },
  signal?: AbortSignal,
  onUpdate?: (update: { details?: WikiProduceToolDetails }) => void,
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  details: WikiProduceToolDetails;
  isError?: boolean;
}>;

const workspace = WorkspaceConfigSchema.parse({
  version: 1,
  id: "workspace",
  name: "Tool Workspace",
  rootPath: "/tmp/okf-wiki-produce-tool",
  sources: [{ id: "main", path: "/tmp/source", applyDefaultIgnores: true, ignore: [] }],
  model: { id: "openai/test" },
  publicationPath: "/tmp/published",
  limits: { requestTimeoutSeconds: 60, maxSteps: 8 },
  planConfirm: true,
  wikiLanguage: "en",
  createdAt: new Date().toISOString(),
});

describe("wiki_produce StartRun receipt", () => {
  it("dispatches startWikiRun and returns accepted without awaiting the Run", async () => {
    const calls: Array<{ commandId: string; sessionId: string; notes?: string }> = [];
    const startWikiRun: StartWikiRun = async (input) => {
      calls.push(input);
      return {
        commandId: input.commandId,
        runId: "run-from-dispatch",
        revision: 1,
        accepted: true,
      };
    };
    const updates: WikiProduceToolDetails[] = [];
    const definition = createWikiProduceTool({
      workspace,
      sessionId: "operator-session",
      startWikiRun,
    });
    assert.equal(definition.name, "wiki_produce");
    assert.match(definition.description, /returns immediately/i);

    const execute = definition.execute as unknown as ExecuteWikiProduce;
    const result = await execute("tool-call-1", { notes: "Focus on runtime." }, undefined, (u) => {
      if (u.details) updates.push(u.details);
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.sessionId, "operator-session");
    assert.equal(calls[0]?.notes, "Focus on runtime.");
    assert.equal(result.isError, undefined);
    assert.equal(result.details.status, "accepted");
    assert.equal(result.details.runId, "run-from-dispatch");
    assert.match(result.details.summary ?? "", /accepted/i);
    assert.equal("spec" in result.details, false);
    assert.equal("graph" in result.details, false);
    for (const update of updates) WikiProduceToolDetailsSchema.parse(update);
    assert.ok(updates.some((update) => update.status === "accepted"));
  });

  it("surfaces dispatch failures as failed tool results", async () => {
    const definition = createWikiProduceTool({
      workspace,
      sessionId: "fail-session",
      startWikiRun: async () => {
        throw new Error("workflow is already open");
      },
    });
    const result = await (definition.execute as unknown as ExecuteWikiProduce)("tool-fail", {});
    assert.equal(result.isError, true);
    assert.equal(result.details.status, "failed");
    assert.match(result.details.summary ?? "", /workflow is already open/);
  });
});
