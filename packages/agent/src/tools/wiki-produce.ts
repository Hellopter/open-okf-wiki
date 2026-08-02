/**
 * Thin Pi adapter: wiki_produce dispatches StartRun and returns a receipt (ADR 0035).
 * WikiRuns owns freeze/plan/gates; this tool does not await the Run.
 */

import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type RunCommandReceipt,
  type RunIntent,
  type WikiProduceToolDetails,
  type WorkspaceConfig,
} from "@okf-wiki/contract";

export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce" as const;

/** Server-composed port: dispatch StartRun into the workspace WikiRuns owner. */
export type StartWikiRun = (input: {
  commandId: string;
  sessionId: string;
  mode: RunIntent["mode"];
  notes?: string;
}) => Promise<RunCommandReceipt>;

export type CreateWikiProduceToolInput = {
  workspace: WorkspaceConfig;
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  /**
   * Server injects WikiRuns StartRun dispatch. Required on the product path.
   * Tests may supply a fake that returns a receipt immediately.
   */
  startWikiRun: StartWikiRun;
};

const wikiProduceParameters = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("generate"), Type.Literal("refresh")], {
        description:
          "Run mode. Use refresh only when the operator explicitly asks to update the existing published Wiki; otherwise omit or use generate.",
      }),
    ),
    notes: Type.Optional(
      Type.String({
        description:
          "Optional free-text focus for this Wiki Run (max 4000 chars). " +
          "Pass the operator's stated emphasis only; do not invent scope. " +
          "Omit when the operator gave no focus.",
        maxLength: 4000,
      }),
    ),
  },
  { additionalProperties: false },
);

function toolResult(details: WikiProduceToolDetails) {
  const text =
    details.summary?.trim() ||
    (details.runId
      ? `Wiki Run ${details.runId}: ${details.status}`
      : `wiki_produce: ${details.status}`);
  return {
    content: [{ type: "text" as const, text }],
    details,
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
      "Start a durable Wiki Run that creates or refreshes the source-grounded repository Wiki.",
      "Returns immediately with runId; plan/publication continue on the Run control plane (this tool does not wait).",
      "",
      "When to use:",
      "- Operator explicitly asks to produce, build, regenerate, refresh, or rewrite the Wiki.",
      "- Operator wants a brand-new Run (not a fix of an existing run's staging).",
      "",
      "Do not use when:",
      "- Operator asks about model, context window, tokens, session status, or configuration → use session_status or answer in text.",
      "- Operator asks to fix/repair staging on an existing run → use wiki_repair with that runId.",
      "- Greetings, general Q&A, sources management, or exploratory chat with no produce intent.",
      "- A prior wiki_produce already returned accepted+runId and the operator only wants progress (report the runId; do not start another Run).",
    ].join("\n"),
    promptSnippet: "Produce/refresh Wiki (explicit operator request only)",
    promptGuidelines: [
      "Call wiki_produce only on explicit Wiki produce/refresh intent.",
      "For an existing published Wiki refresh, pass mode: refresh; omit mode or use generate for a new Wiki Run.",
      "For questions about context window, tokens, session status, or configuration: answer in text or use session_status — never wiki_produce.",
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
          summary:
            "Wiki Run start was cancelled before dispatch. Ask the operator whether to retry wiki_produce; do not assume a runId exists.",
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
        const commandId = randomUUID();
        const receipt = await input.startWikiRun({
          commandId,
          sessionId: input.sessionId,
          mode: args.mode ?? "generate",
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
          error instanceof Error ? error.message.slice(0, 3500) : "Failed to start Wiki Run";
        const details: WikiProduceToolDetails = {
          status: "failed",
          summary:
            `Failed to start Wiki Run: ${message}. ` +
            "If a run is already open, report that runId and wait or use wiki_repair; " +
            "do not retry wiki_produce until the operator confirms a new Run is wanted.",
        };
        return { ...toolResult(details), isError: true };
      }
    },
  });
}
