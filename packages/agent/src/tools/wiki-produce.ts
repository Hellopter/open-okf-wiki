/**
 * Thin Pi adapter: real wiki_produce tool (ADR 0032).
 * All Wiki Run logic lives in runWiki.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  toDurableWikiProduceDetails,
  type WikiProduceDurableDetails,
  type WikiProduceToolDetails,
  type WorkspaceConfig,
} from "@okf-wiki/contract";
import type { AgentRunner } from "../ports/agent-runner.js";
import { resolveProduceRuntime } from "../runtime/produce-runtime.js";
import { requestTimeoutMs } from "../workflow/budgets.js";
import {
  type GatePort,
  type RunWikiInput,
  runWiki,
  type WikiProduceModelFactory,
} from "../workflow/run-wiki.js";
import { createSubmitWikiRunSpecTool } from "./submit-wiki-run-spec.js";
import { createToolDetailsAccumulator } from "./wiki-produce-details.js";

export const WIKI_PRODUCE_TOOL_NAME = "wiki_produce" as const;

export type {
  GateDecision,
  GatePort,
  GateRequest,
  WikiProduceModelFactory,
  WikiProduceModelRole,
} from "../workflow/run-wiki.js";

export type CreateWikiProduceToolInput = {
  workspace: WorkspaceConfig;
  resolveWorkspace?: () => Promise<WorkspaceConfig>;
  sessionId: string;
  gateCoordinator: GatePort;
  resolveModel?: WikiProduceModelFactory;
  fixture?: boolean;
  autoApprove?: boolean;
  /** Inject runtime for tests; otherwise resolved from fixture/live at execute. */
  runtime?: AgentRunner;
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
  let text =
    durable.summary?.trim() ||
    (durable.runId
      ? `Wiki Run ${durable.runId}: ${durable.status}`
      : `wiki_produce: ${durable.status}`);
  // Surface runId in text so the Operator can call wiki_repair without digging into details.
  if (
    durable.runId &&
    (durable.status === "failed" || durable.status === "publication_declined") &&
    !text.includes(durable.runId)
  ) {
    text = `${text} (runId=${durable.runId}; repair staging with wiki_repair)`;
  }
  return {
    content: [{ type: "text" as const, text }],
    details: durable,
  };
}

/** Build the LLM-callable Pi tool. One execute owns one complete Wiki Run via runWiki. */
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
    ].join(" "),
    promptSnippet: "Produce/refresh Wiki (explicit operator request only)",
    promptGuidelines: [
      "Call wiki_produce only on explicit Wiki produce/refresh intent.",
      "For questions about context window, tokens, session status, or configuration: answer in text or use session_status if available — never wiki_produce.",
      "To fix or repair an existing Wiki Run staging, call wiki_repair (never bash).",
      "Pass operator focus via notes; do not invent a run for exploratory chat.",
    ],
    parameters: wikiProduceParameters,
    executionMode: "sequential",
    async execute(toolCallId, args, signal, onUpdate) {
      const acc = createToolDetailsAccumulator({ status: "freezing" });
      const push = (): void => {
        try {
          onUpdate?.(acc.toPartial());
        } catch {
          // display must not break the run
        }
      };

      const runtime = resolveProduceRuntime({
        fixture: input.fixture,
        runtime: input.runtime,
        defaults: {
          timeoutMs: requestTimeoutMs(input.workspace),
          retry: input.workspace?.limits?.retry,
        },
      });

      const runInput: RunWikiInput = {
        workspace: input.workspace,
        resolveWorkspace: input.resolveWorkspace,
        sessionId: input.sessionId,
        toolCallId,
        notes: args.notes,
        autoApprove: input.autoApprove,
        gateCoordinator: input.gateCoordinator,
        resolveModel: input.resolveModel,
        fixture: input.fixture,
        runtime,
        abortSignal: signal,
        // Tool edge owns Pi tools; workflow injects them as opaque customTools.
        createPlanTools: (runWorkDir) => [createSubmitWikiRunSpecTool({ runWorkDir })],
        // Single channel: phase/meta + graph all arrive as ProduceProgress.
        onProgress: (progress) => {
          acc.apply(progress);
          push();
        },
      };

      const result = await runWiki(runInput);
      // Final state from runWiki is authoritative for toolResult
      Object.assign(acc.details, result);
      return toolResult(acc.details);
    },
  });
}
