/**
 * Thin Pi adapter: wiki_repair tool.
 * Admission, layout bootstrap, and write path live in repairWikiGuarded / repairWiki.
 * Never bash for wiki fixes.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WikiProduceToolDetails, WorkspaceConfig } from "@okf-wiki/contract";
import type { AgentRunner } from "../ports/agent-runner.js";
import { resolveProduceRuntime } from "../runtime/produce-runtime.js";
import { repairWikiGuarded } from "../workflow/repair-guarded.js";
import { applyGraphProgress, createRunGraphOwner } from "../workflow/run-graph-owner.js";
import type { WikiProduceModelFactory } from "../workflow/run-wiki.js";
import { createToolDetailsAccumulator } from "./wiki-produce-details.js";

export const WIKI_REPAIR_TOOL_NAME = "wiki_repair" as const;

export type CreateWikiRepairToolInput = {
  workspace: WorkspaceConfig;
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  resolveModel?: WikiProduceModelFactory;
  fixture?: boolean;
  /** Inject runtime for tests. */
  runtime?: AgentRunner;
};

const wikiRepairParameters = Type.Object(
  {
    runId: Type.String({
      description: "Existing Wiki Run id whose staging wiki should be repaired.",
      minLength: 1,
      maxLength: 200,
    }),
    notes: Type.Optional(
      Type.String({
        description: "Operator repair focus or defect notes.",
        maxLength: 4000,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WikiRepairToolDetails = {
  status: "repairing" | "repaired" | "failed" | "cancelled";
  runId?: string;
  pages?: string[];
  summary?: string;
  /**
   * Live attempt graph forwarded from the repair workflow (same snapshot shape
   * as wiki_produce). Status stays the repair enum above — never "producing".
   */
  graph?: WikiProduceToolDetails["graph"];
};

/** Normalize repair tool early/final returns (content + details [+ isError]). */
export function toRepairToolResult(
  details: WikiRepairToolDetails,
  opts?: { isError?: boolean },
): {
  content: Array<{ type: "text"; text: string }>;
  details: WikiRepairToolDetails;
  isError?: boolean;
} {
  return {
    content: [{ type: "text" as const, text: details.summary ?? details.status }],
    details,
    ...(opts?.isError ? { isError: true as const } : {}),
  };
}

/** Pure factory test seam: build tool definition without session. */
export function createWikiRepairTool(
  input: CreateWikiRepairToolInput,
): ToolDefinition<typeof wikiRepairParameters, WikiRepairToolDetails> {
  return defineTool({
    name: WIKI_REPAIR_TOOL_NAME,
    label: "Repair wiki",
    description: [
      "Repair the Staging Wiki for an existing Wiki Run (root_write only).",
      "Use when the operator asks to fix, repair, or address defects on an existing run.",
      "Requires runId. Does NOT freeze a new run. Never use bash for wiki fixes.",
    ].join(" "),
    promptSnippet: "Repair existing Wiki Run staging (runId required)",
    promptGuidelines: [
      "When the operator asks to fix or repair the Wiki for an existing run, call wiki_repair with that runId.",
      "Never use bash to edit wiki pages — always wiki_repair (or wiki_produce for a full new run).",
      "Do not call wiki_repair to start a new Wiki Run; use wiki_produce for produce/refresh.",
    ],
    parameters: wikiRepairParameters,
    executionMode: "sequential",
    async execute(_toolCallId, args, signal, onUpdate) {
      const acc = createToolDetailsAccumulator({
        status: "producing",
        runId: args.runId,
        summary: "Repairing Staging Wiki",
      });
      /** Repair path has no runWiki shell; local owner projects attempts → graph. */
      const graphOwner = createRunGraphOwner();
      const push = (details: WikiRepairToolDetails): void => {
        try {
          onUpdate?.({
            content: [{ type: "text" as const, text: details.summary ?? details.status }],
            details,
          });
        } catch {
          // display must not break repair
        }
      };

      const runId = args.runId.trim();
      if (!runId) {
        return toRepairToolResult({
          status: "failed",
          summary: "runId is required",
        });
      }

      const workspace = input.resolveWorkspace ? await input.resolveWorkspace() : input.workspace;
      const runtime = resolveProduceRuntime({
        fixture: input.fixture,
        runtime: input.runtime,
        defaults: {
          timeoutMs:
            typeof workspace.limits?.requestTimeoutSeconds === "number" &&
            workspace.limits.requestTimeoutSeconds > 0
              ? workspace.limits.requestTimeoutSeconds * 1000
              : undefined,
          retry: workspace.limits?.retry,
        },
      });

      let writerModel: { model?: unknown; modelRuntime?: unknown; maxContextTokens?: number } =
        {};
      if (!input.fixture && runtime.kind === "live" && input.resolveModel) {
        writerModel = await input.resolveModel("writer", workspace);
      }

      const notes = args.notes?.trim();
      const defectNotes = notes
        ? `Operator repair notes:\n${notes}`
        : "Operator requested repair of Staging Wiki; fix grounding, coverage, and consistency issues.";

      push({ status: "repairing", runId, summary: "root_write repair" });
      acc.apply({ kind: "status", status: "producing", summary: "root_write repair" });
      acc.apply({ kind: "runId", runId });

      const produced = await repairWikiGuarded({
        runId,
        workspace,
        sessionId: input.sessionId,
        runtime,
        models: writerModel.model
          ? {
              writer: {
                model: writerModel.model,
                modelRuntime: writerModel.modelRuntime,
                maxContextTokens: writerModel.maxContextTokens,
              },
            }
          : undefined,
        defectNotes,
        abortSignal: signal,
        contextTargetTokens: workspace.limits?.contextTargetTokens,
        onProgress: (progress) => {
          // Graph authority is local owner; live details keep repair status enum.
          applyGraphProgress(graphOwner, progress, (graph) => {
            acc.apply({ kind: "graph", graph });
            push({
              status: "repairing",
              runId,
              summary: "root_write repair",
              graph,
            });
          });
        },
      });

      if (produced.status === "cancelled") {
        return toRepairToolResult({
          status: "cancelled",
          runId: produced.runId,
          summary: produced.summary || "Wiki repair cancelled",
        });
      }

      if (produced.status === "failed") {
        return toRepairToolResult(
          {
            status: "failed",
            runId: produced.runId,
            summary: produced.summary,
          },
          produced.isError ? { isError: true } : undefined,
        );
      }

      return toRepairToolResult({
        status: "repaired",
        runId: produced.runId,
        pages: produced.pages,
        summary: produced.summary,
      });
    },
  });
}
