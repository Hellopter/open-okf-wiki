/**
 * Thin Pi adapter: wiki_produce dispatches StartRun and returns a receipt (ADR 0035).
 * WikiRuns owns freeze/plan/gates; this tool does not await the Run.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type RunCommandReceipt,
  toDurableWikiProduceDetails,
  type WikiProduceDurableDetails,
  type WikiProduceToolDetails,
  type WorkspaceConfig,
} from "@okf-wiki/contract";

export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce" as const;

/** Server-composed port: dispatch StartRun into the workspace WikiRuns owner. */
export type StartWikiRun = (input: {
  commandId: string;
  sessionId: string;
  notes?: string;
}) => Promise<RunCommandReceipt>;

export type WikiProduceModelRole = "writer" | "planner" | "worker" | "reviewer";

export type WikiProduceModelFactory = (
  role: WikiProduceModelRole,
  workspace: WorkspaceConfig,
  opts?: { seatIndex?: number },
) => Promise<{
  model: unknown;
  modelRuntime?: unknown;
  maxContextTokens?: number;
}>;

export type CreateWikiProduceToolInput = {
  workspace: WorkspaceConfig;
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  /**
   * Server injects WikiRuns StartRun dispatch. Required on the product path.
   * Tests may supply a fake that returns a receipt immediately.
   */
  startWikiRun: StartWikiRun;
  resolveModel?: WikiProduceModelFactory;
  fixture?: boolean;
};

const wikiProduceParameters = Type.Object(
  {
    notes: Type.Optional(
      Type.String({
        description: "Optional operator-requested focus for this Wiki Run.",
        maxLength: 4000,
      }),
    ),
  },
  { additionalProperties: false },
);

function toolResult(details: WikiProduceToolDetails) {
  const durable: WikiProduceDurableDetails = toDurableWikiProduceDetails(details);
  const text =
    durable.summary?.trim() ||
    (durable.runId
      ? `Wiki Run ${durable.runId}: ${durable.status}`
      : `wiki_produce: ${durable.status}`);
  return {
    content: [{ type: "text" as const, text }],
    details: durable,
  };
}

/** Build the LLM-callable Pi tool. Execute dispatches StartRun and returns the receipt. */
export function createWikiProduceTool(
  input: CreateWikiProduceToolInput,
): ToolDefinition<typeof wikiProduceParameters, WikiProduceToolDetails> {
  return defineTool({
    name: WIKI_PRODUCE_TOOL_NAME,
    label: "Produce wiki",
    description: [
      "Create or refresh the source-grounded repository Wiki.",
      "ONLY when the operator explicitly asks to produce, build, regenerate, refresh, or rewrite the Wiki.",
      "Do NOT call for: model/context/token questions, settings, sources management, greetings, or general Q&A.",
      "Starts a durable Wiki Run and returns immediately with runId; it does not wait for plan or publication.",
    ].join(" "),
    promptSnippet: "Produce/refresh Wiki (explicit operator request only)",
    promptGuidelines: [
      "Call wiki_produce only on explicit Wiki produce/refresh intent.",
      "For questions about context window, tokens, session status, or configuration: answer in text or use session_status if available — never wiki_produce.",
      "To fix or repair an existing Wiki Run staging, call wiki_repair (never bash).",
      "Pass operator focus via notes; do not invent a run for exploratory chat.",
      "After wiki_produce returns accepted+runId, tell the operator the Run is durable and plan/publication gates are resolved via the Run API — do not pretend the tool is still running.",
    ],
    parameters: wikiProduceParameters,
    executionMode: "sequential",
    async execute(_toolCallId, args, signal, onUpdate) {
      if (signal?.aborted) {
        const cancelled: WikiProduceToolDetails = {
          status: "cancelled",
          summary: "Wiki Run start was cancelled before dispatch",
        };
        return toolResult(cancelled);
      }

      const accepting: WikiProduceToolDetails = {
        status: "accepted",
        summary: "Dispatching durable Wiki Run…",
      };
      try {
        onUpdate?.({ content: [{ type: "text", text: accepting.summary! }], details: accepting });
      } catch {
        // display must not break dispatch
      }

      try {
        // Fresh workspace snapshot so long-lived sessions see saved edits.
        if (input.resolveWorkspace) {
          await input.resolveWorkspace();
        }
        const commandId = crypto.randomUUID();
        const receipt = await input.startWikiRun({
          commandId,
          sessionId: input.sessionId,
          ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
        });
        const details: WikiProduceToolDetails = {
          status: "accepted",
          runId: receipt.runId,
          summary: `Wiki Run accepted (revision ${receipt.revision}). Plan and publication continue on the durable Run control plane.`,
        };
        return toolResult(details);
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 4000) : "Failed to start Wiki Run";
        const details: WikiProduceToolDetails = {
          status: "failed",
          summary: message,
        };
        return { ...toolResult(details), isError: true };
      }
    },
  });
}
