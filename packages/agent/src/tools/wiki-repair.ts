/**
 * Thin Pi adapter: wiki_repair dispatches RerunNode (ADR 0035).
 * WikiRuns owns repair Attempts; this tool does not bypass the control plane
 * or write shared staging outside an Attempt workdir.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunCommandReceipt, WorkspaceConfig } from "@okf-wiki/contract";

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
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  /**
   * Optional durable RerunNode dispatch. When omitted, the tool fails closed
   * and points operators at Run commands (no pure produce/repairWiki bypass).
   */
  rerunWikiNode?: RerunWikiNode;
  /**
   * Resolve the current generation for a repair target (typically write.root).
   * Server should read WikiRuns snapshot; tests may stub.
   */
  resolveRepairTarget?: (input: {
    runId: string;
  }) => Promise<{ nodeKey: string; generation: number } | null>;
};

const wikiRepairParameters = Type.Object(
  {
    runId: Type.String({
      description: "Existing Wiki Run id whose graph node should be re-run for repair.",
      minLength: 1,
      maxLength: 200,
    }),
    notes: Type.Optional(
      Type.String({
        description: "Operator repair focus or defect notes (RerunNode feedback).",
        maxLength: 4000,
      }),
    ),
    nodeKey: Type.Optional(
      Type.String({
        description: "Optional node key to rerun (default: write.root).",
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
      "Request a durable RerunNode for an existing Wiki Run (default write.root).",
      "Use when the operator asks to fix or repair staging on an existing run.",
      "Dispatches a WikiRuns command and returns a receipt; it does not own the Attempt.",
      "Never use bash for wiki fixes.",
    ].join(" "),
    promptSnippet: "Rerun a Wiki Run node for repair (runId required)",
    promptGuidelines: [
      "When the operator asks to fix or repair the Wiki for an existing run, call wiki_repair with that runId.",
      "Never use bash to edit wiki pages — always wiki_repair (or wiki_produce for a full new run).",
      "Do not call wiki_repair to start a new Wiki Run; use wiki_produce for produce/refresh.",
    ],
    parameters: wikiRepairParameters,
    executionMode: "sequential",
    async execute(_toolCallId, args, signal, onUpdate) {
      if (signal?.aborted) {
        return toRepairToolResult({
          status: "cancelled",
          runId: args.runId,
          summary: "Wiki repair dispatch was cancelled",
        });
      }

      const runId = args.runId.trim();
      if (!runId) {
        return toRepairToolResult(
          { status: "failed", summary: "runId is required" },
          { isError: true },
        );
      }

      if (!input.rerunWikiNode) {
        return toRepairToolResult(
          {
            status: "failed",
            runId,
            summary:
              "wiki_repair requires WikiRuns RerunNode dispatch; use the Run API (rerun_node) or wire rerunWikiNode at composition",
          },
          { isError: true },
        );
      }

      if (input.resolveWorkspace) await input.resolveWorkspace();

      const preferredKey = args.nodeKey?.trim() || "write.root";
      let target = { nodeKey: preferredKey, generation: 0 };
      if (input.resolveRepairTarget) {
        const resolved = await input.resolveRepairTarget({ runId });
        if (!resolved) {
          return toRepairToolResult(
            {
              status: "failed",
              runId,
              summary: `No rerunnable node found for run ${runId}`,
            },
            { isError: true },
          );
        }
        target = args.nodeKey?.trim()
          ? { nodeKey: preferredKey, generation: resolved.generation }
          : resolved;
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
            summary: message.slice(0, 4_000),
          },
          { isError: true },
        );
      }
    },
  });
}
