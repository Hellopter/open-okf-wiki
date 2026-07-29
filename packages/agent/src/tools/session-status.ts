/**
 * Read-only operator tool: answer meta questions (context budget, sources)
 * without starting a Wiki Run.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkspaceConfig } from "@okf-wiki/contract";
import { resolveContextBudget } from "../runtime/context-budget.js";

export const SESSION_STATUS_TOOL_NAME = "session_status" as const;

export type CreateSessionStatusToolInput = {
  workspace: WorkspaceConfig;
  model?: Model<any>;
  maxContextTokens?: number;
  contextTargetTokens?: number;
};

const sessionStatusParameters = Type.Object({}, { additionalProperties: false });

/**
 * Lightweight status tool for the Operator Session.
 * Never freezes sources or starts wiki_produce.
 */
export function createSessionStatusTool(
  input: CreateSessionStatusToolInput,
): ToolDefinition<typeof sessionStatusParameters, Record<string, unknown>> {
  return defineTool({
    name: SESSION_STATUS_TOOL_NAME,
    label: "Session status",
    description: [
      "Read-only report of operator session and workspace status: model id, context window (tokens),",
      "compaction target (tokens), source count/ids, planConfirm, and wiki language.",
      "Never freezes sources and never starts a Wiki Run.",
      "",
      "When to use:",
      "- Operator asks about context size, tokens, model, sources, plan confirm, readiness, or configuration.",
      "- You need current workspace facts before answering a meta question.",
      "",
      "Do not use when:",
      "- Operator asks to produce or refresh the Wiki → use wiki_produce (Do NOT use this tool to produce or refresh the Wiki).",
      "- Operator asks to fix/repair an existing run → use wiki_repair with runId.",
      "- You already have the needed facts from a recent session_status result in this turn (answer from that; avoid redundant calls).",
    ].join("\n"),
    promptSnippet: "Read-only session/workspace status (context, sources, config)",
    promptGuidelines: [
      "Prefer session_status for context/token/config questions.",
      "Never call wiki_produce when the operator only asks for status or context size.",
      "session_status is read-only: it does not start runs, freeze sources, or change settings.",
    ],
    parameters: sessionStatusParameters,
    async execute(_toolCallId, _args) {
      const budget = resolveContextBudget({
        maxContextTokens: input.maxContextTokens ?? input.model?.contextWindow,
        contextTargetTokens:
          input.contextTargetTokens ?? input.workspace.limits?.contextTargetTokens,
      });
      const payload = {
        workspaceId: input.workspace.id,
        workspaceName: input.workspace.name,
        modelId: input.model?.id ?? input.workspace.model.id,
        modelProvider: input.model?.provider,
        contextWindow: budget.contextWindow,
        contextTargetTokens: budget.contextTarget,
        sourceCount: input.workspace.sources.length,
        sourceIds: input.workspace.sources.map((s) => s.id),
        // Same default as the run's plan gate (requirePlanGate):
        // OFF unless explicitly enabled (schema default is false).
        planConfirm: input.workspace.planConfirm === true,
        wikiLanguage: input.workspace.wikiLanguage ?? "en",
        skillPath: input.workspace.skillPath ?? null,
      };
      const text = [
        `Workspace: ${payload.workspaceName} (${payload.workspaceId})`,
        `Model: ${payload.modelId}${payload.modelProvider ? ` @ ${payload.modelProvider}` : ""}`,
        `Context window: ${payload.contextWindow} tokens`,
        `Context target (compaction): ${payload.contextTargetTokens} tokens`,
        `Sources: ${payload.sourceCount} (${payload.sourceIds.join(", ") || "none"})`,
        `Plan confirm: ${payload.planConfirm}`,
        `Wiki language: ${payload.wikiLanguage}`,
      ].join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: payload,
      };
    },
  });
}
