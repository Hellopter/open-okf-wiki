/**
 * Thin Pi adapter: wiki_repair dispatches RerunNode (ADR 0035).
 * WikiRuns owns repair Attempts; this tool does not bypass the control plane
 * or write shared staging outside an Attempt workdir.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunCommandReceipt } from "@okf-wiki/contract/wiki-runs";
import type { WorkspaceConfig } from "@okf-wiki/contract/workspace";

export const WIKI_REPAIR_TOOL_NAME = "wiki_repair" as const;

/** Server-composed port: dispatch RerunNode into the workspace WikiRuns owner. */
export type RerunWikiNode = (input: {
  commandId: string;
  runId: string;
  nodeKey: string;
  generation: number;
  feedback?: string;
  sessionId: string;
}) => Promise<RunCommandReceipt>;

export type CreateWikiRepairToolInput = {
  workspace: WorkspaceConfig;
  sessionId: string;
  /**
   * Optional durable RerunNode dispatch. When omitted, the tool fails closed
   * and points operators at Run commands (no pure produce/repairWiki bypass).
   */
  rerunWikiNode?: RerunWikiNode;
  /**
   * Resolve the current generation for a repair target. A supplied nodeKey must
   * resolve that exact current node; when omitted, the server selects a default.
   */
  resolveRepairTarget?: (input: {
    runId: string;
    nodeKey?: string;
  }) => Promise<{ nodeKey: string; generation: number } | null>;
};

const wikiRepairParameters = Type.Object(
  {
    runId: Type.String({
      description:
        "Existing Wiki Run id (1–200 chars) whose graph node should be re-run. " +
        "Required — take from a prior wiki_produce receipt or operator message. " +
        "Do not invent runIds.",
      minLength: 1,
      maxLength: 200,
    }),
    notes: Type.Optional(
      Type.String({
        description:
          "Operator repair focus or defect notes passed as RerunNode feedback (max 4000 chars). " +
          "Summarize the defect the operator named; omit if none given.",
        maxLength: 4000,
      }),
    ),
    nodeKey: Type.Optional(
      Type.String({
        description:
          "Graph node key to rerun (1–200 chars). Default when omitted: write.root. " +
          "Only set when the operator or run status names a specific node.",
        minLength: 1,
        maxLength: 200,
      }),
    ),
  },
  { additionalProperties: false },
);

export type WikiRepairToolDetails = {
  status: "repairing" | "repaired" | "failed" | "cancelled" | "accepted";
  runId?: string;
  nodeKey?: string;
  generation?: number;
  commandId?: string;
  summary?: string;
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
      "Request a durable RerunNode for an existing Wiki Run (default node: write.root).",
      "Dispatches a WikiRuns command and returns a receipt; does not own the Attempt or write staging outside the control plane.",
      "",
      "When to use:",
      "- Operator asks to fix, repair, or re-run staging/pages on an existing Wiki Run and supplies (or context has) a runId.",
      "- A prior produce run left fixable defects and the operator wants repair, not a brand-new Run.",
      "",
      "Do not use when:",
      "- No existing runId is known → ask the operator, or use wiki_produce to start a new Run.",
      "- Operator wants a full produce/refresh of the Wiki → use wiki_produce.",
      "- Context/token/config questions → use session_status.",
      "- Never use bash (or other write tools) to edit wiki pages; always wiki_repair or wiki_produce.",
    ].join("\n"),
    promptSnippet: "Rerun a Wiki Run node for repair (runId required)",
    promptGuidelines: [
      "When the operator asks to fix or repair the Wiki for an existing run, call wiki_repair with that runId.",
      "Never use bash to edit wiki pages — always wiki_repair (or wiki_produce for a full new run).",
      "Do not call wiki_repair to start a new Wiki Run; use wiki_produce for produce/refresh.",
      "If runId is missing, ask the operator or fall back to wiki_produce — do not invent a runId.",
    ],
    parameters: wikiRepairParameters,
    executionMode: "sequential",
    async execute(_toolCallId, args, signal, onUpdate) {
      if (signal?.aborted) {
        return toRepairToolResult({
          status: "cancelled",
          runId: args.runId,
          summary:
            "Wiki repair dispatch was cancelled before RerunNode. Ask the operator whether to retry wiki_repair with the same runId.",
        });
      }

      const runId = args.runId.trim();
      if (!runId) {
        return toRepairToolResult(
          {
            status: "failed",
            summary:
              "runId is required (non-empty string, max 200 chars). " +
              "Pass the existing Wiki Run id from a prior wiki_produce receipt or operator message. " +
              "To start a new Run instead, use wiki_produce.",
          },
          { isError: true },
        );
      }

      if (!input.rerunWikiNode) {
        return toRepairToolResult(
          {
            status: "failed",
            runId,
            summary:
              "wiki_repair is not wired for RerunNode in this session. " +
              "Tell the operator to use the Run API command rerun_node for this runId, " +
              "or retry after the host wires rerunWikiNode at composition. Do not use bash to edit wiki pages.",
          },
          { isError: true },
        );
      }

      const requestedNodeKey = args.nodeKey?.trim();
      const preferredKey = requestedNodeKey || "write.root";
      let target = { nodeKey: preferredKey, generation: 0 };
      if (input.resolveRepairTarget) {
        const resolved = await input.resolveRepairTarget({
          runId,
          ...(requestedNodeKey ? { nodeKey: requestedNodeKey } : {}),
        });
        if (!resolved) {
          return toRepairToolResult(
            {
              status: "failed",
              runId,
              summary:
                `No rerunnable node found for run ${runId}. ` +
                "Confirm the runId is correct and the run still exists with a repairable node. " +
                "If the operator wants a brand-new Wiki, use wiki_produce instead of wiki_repair.",
            },
            { isError: true },
          );
        }
        if (requestedNodeKey && resolved.nodeKey !== requestedNodeKey) {
          return toRepairToolResult(
            {
              status: "failed",
              runId,
              nodeKey: requestedNodeKey,
              summary:
                `The current generation for ${requestedNodeKey} could not be resolved. ` +
                "Refresh the Run status and retry with a listed node key; do not rerun a different node.",
            },
            { isError: true },
          );
        }
        target = resolved;
      }

      const commandId = `wiki_repair:${runId}:${target.nodeKey}:${Date.now()}`;
      const accepting: WikiRepairToolDetails = {
        status: "accepted",
        runId,
        nodeKey: target.nodeKey,
        generation: target.generation,
        commandId,
        summary: `Dispatching RerunNode ${target.nodeKey}@${target.generation}…`,
      };
      try {
        onUpdate?.({
          content: [{ type: "text", text: accepting.summary! }],
          details: accepting,
        });
      } catch {
        // display must not break dispatch
      }

      try {
        const receipt = await input.rerunWikiNode({
          commandId,
          runId,
          nodeKey: target.nodeKey,
          generation: target.generation,
          feedback: args.notes?.trim() || undefined,
          sessionId: input.sessionId,
        });
        return toRepairToolResult({
          status: "accepted",
          runId: receipt.runId,
          nodeKey: target.nodeKey,
          generation: target.generation,
          commandId: receipt.commandId,
          summary: `RerunNode accepted for ${target.nodeKey}@${target.generation} (revision ${receipt.revision})`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toRepairToolResult(
          {
            status: "failed",
            runId,
            nodeKey: target.nodeKey,
            generation: target.generation,
            summary:
              `RerunNode failed for ${target.nodeKey}@${target.generation}: ${message.slice(0, 3_500)}. ` +
              "If generation is stale, re-resolve the run and retry wiki_repair once; " +
              "if the run is gone, use wiki_produce for a new Run. Do not edit wiki pages via bash.",
          },
          { isError: true },
        );
      }
    },
  });
}
