import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { wikiToolRejected } from "../wiki-tool-error.js";

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;

const emptyParameters = Type.Object({}, { additionalProperties: false });

export const WIKI_DELEGATE_CANCEL_REASON_CODES = ["superseded", "blocked", "user_requested"] as const;
export type WikiDelegateCancelReasonCode = typeof WIKI_DELEGATE_CANCEL_REASON_CODES[number];

export function createWikiPlanTool(save: () => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_plan",
    label: "Submit Wiki plan",
    description: "Accept the WikiSpec from the Run's fixed plan file.",
    promptSnippet: "Accept the prepared WikiSpec",
    promptGuidelines: ["Prepare the plan file before calling wiki_plan."],
    parameters: emptyParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        return toolResult(await save());
      } catch (error) {
        rejectWikiTool("wiki_plan", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiTaxonomyTool(save: () => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_taxonomy",
    label: "Accept Wiki taxonomy",
    description: "Accept the taxonomy from the Run's fixed taxonomy file.",
    promptSnippet: "Accept the prepared taxonomy",
    promptGuidelines: ["Prepare the taxonomy file after discovery."],
    parameters: emptyParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try { return toolResult(await save()); }
      catch (error) { rejectWikiTool("wiki_taxonomy", error); }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateStartTool(start: () => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_start",
    label: "Start Wiki tasks",
    description: "Start the unique next wave derived from durable Run state.",
    promptSnippet: "Start the next ready Wiki wave",
    promptGuidelines: ["Prepare the discovery file before the first wave."],
    parameters: emptyParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      const result = await start();
      return toolResult(result);
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateCollectTool(
  collect: (options: { until: "any" | "all"; timeoutSeconds: number }) => Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_collect",
    label: "Collect Wiki tasks",
    description: "Collect completed receipts from an asynchronous Wiki task batch, optionally waiting for any or all pending tasks.",
    promptSnippet: "Collect receipts from a started Wiki task batch",
    promptGuidelines: ["Use timeoutSeconds 0 for a non-blocking status check."],
    parameters: Type.Object({
      until: StringEnum(["any", "all"]),
      timeoutSeconds: Type.Integer({ minimum: 0, maximum: 60 }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        const input = params as { until: "any" | "all"; timeoutSeconds: number };
        return toolResult(await collect({ until: input.until, timeoutSeconds: input.timeoutSeconds }));
      } catch (error) {
        rejectWikiTool("wiki_delegate_collect", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateCancelTool(
  cancel: (reasonCode?: WikiDelegateCancelReasonCode) => Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_cancel",
    label: "Cancel Wiki tasks",
    description: "Cancel the current Wiki wave.",
    promptSnippet: "Cancel the current Wiki wave",
    parameters: Type.Object({
      reasonCode: Type.Optional(StringEnum([...WIKI_DELEGATE_CANCEL_REASON_CODES])),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        const input = params as { reasonCode?: WikiDelegateCancelReasonCode };
        return toolResult(await cancel(input.reasonCode));
      } catch (error) {
        rejectWikiTool("wiki_delegate_cancel", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiFinishTool(finish: () => unknown | Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_finish",
    label: "Finish Wiki workflow",
    description: "Finish after the candidate Wiki is complete and sufficiently grounded.",
    promptSnippet: "Finish after the candidate Wiki is complete and reviewed",
    promptGuidelines: ["Call wiki_finish only after current passing reviews."],
    parameters: emptyParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        return toolResult(await finish());
      } catch (error) {
        rejectWikiTool("wiki_finish", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function rejectWikiTool(tool: string, error: unknown): never {
  if (error instanceof Error && error.message.startsWith(`${tool} rejected:`)) throw error;
  throw wikiToolRejected(tool, error instanceof Error ? error.message : String(error));
}
