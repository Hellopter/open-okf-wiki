import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WikiReviewResult } from "../delegate-contracts.js";
import { wikiToolRejected } from "../wiki-tool-error.js";
import { wikiPlanParameters } from "./spec.js";

const JSON_SCHEMA_PREFER = { type: "json_schema", strict: "prefer" } as const;

const delegateTaskBase = {
  id: Type.String({ minLength: 1, maxLength: 128 }),
  instruction: Type.String({ minLength: 1 }),
  sourceScopeIds: Type.Array(Type.String()),
  contextRefs: Type.Array(Type.String()),
};

export interface WikiLeadDelegateTask {
  id: string;
  role: "research" | "write" | "review";
  instruction: string;
  cluster?: string;
  sourceScopeIds: string[];
  contextRefs: string[];
  mode?: "discovery" | "supplement";
  assignmentIds?: string[];
  domainScopeIds?: string[];
  lensScopeIds?: string[];
  resolvesIds?: string[];
}

const delegateTaskSchema = Type.Union([
  Type.Object({
    ...delegateTaskBase,
    role: StringEnum(["research"]),
    mode: StringEnum(["discovery", "supplement"]),
    assignmentIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    domainScopeIds: Type.Array(Type.String()),
    lensScopeIds: Type.Array(Type.String()),
    resolvesIds: Type.Array(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    ...delegateTaskBase,
    role: StringEnum(["write"]),
    cluster: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    ...delegateTaskBase,
    role: StringEnum(["review"]),
    cluster: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);

const taxonomyDecisionSchema = Type.Object({
  sourceScopeId: Type.String({ minLength: 1 }),
  domainId: Type.String({ minLength: 1 }),
  conceptIds: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

const reviewFindingSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128, description: "Stable finding ID referenced by the Markdown handoff" }),
  path: Type.String({ minLength: 1, description: "Assigned candidate path for this finding" }),
  severity: StringEnum(["critical", "major", "minor"], { description: "Finding severity" }),
}, { additionalProperties: false });

export function createWikiPlanTool(save: (spec: unknown) => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_plan",
    label: "Submit Wiki plan",
    description: "Submit the WikiSpec page path list before any page is written or reviewed. A revision invalidates prior reviews.",
    promptSnippet: "Submit the WikiSpec page path list before writing or reviewing pages",
    promptGuidelines: [
      "Call wiki_plan before writing pages.",
      "wiki_plan pages are wiki-relative paths such as overview.md and core/domain.md.",
      "The host derives pageType and cluster identity from those paths.",
      "Do not send version, frontmatter, or page objects.",
    ],
    parameters: wikiPlanParameters,
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        return toolResult(await save(params));
      } catch (error) {
        rejectWikiTool("wiki_plan", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiTaxonomyTool(save: (taxonomy: unknown) => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_taxonomy",
    label: "Accept Wiki taxonomy",
    description: "Accept the source-qualified taxonomy checkpoint before submitting wiki_plan. The host records its digest and conflict IDs.",
    promptSnippet: "Accept the source-qualified taxonomy checkpoint before wiki_plan",
    promptGuidelines: [
      "Call wiki_taxonomy after the discovery research wave and before wiki_plan.",
      "Keep sourceScopeId, domainId, and conceptIds source-qualified and evidence-backed.",
      "Record unresolved conflict IDs instead of silently merging minority evidence.",
    ],
    parameters: Type.Object({
      revision: Type.Integer({ minimum: 1 }),
      decisions: Type.Array(taxonomyDecisionSchema, { minItems: 1 }),
      conflictIds: Type.Array(Type.String({ minLength: 1 })),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try { return toolResult(await save(params)); }
      catch (error) { rejectWikiTool("wiki_taxonomy", error); }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateStartTool(start: (tasks: WikiLeadDelegateTask[]) => Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_start",
    label: "Start Wiki tasks",
    description: "Durably queue one logical wave of all ready independent Wiki tasks; runtime concurrency controls actual sessions and retries remain attempts.",
    promptSnippet: "Queue one logical discovery, supplement, write, or review wave",
    promptGuidelines: [
      "Each instruction must state its goal, scope, expected artifact or page, and stop condition.",
      "When chaining delegated work, populate contextRefs from the exact nodeId values in prior receipt.outputs entries.",
      "Do not mix write and review tasks in one wiki_delegate_start batch.",
      "write and review tasks require a current Spec cluster id; the host expands it to wiki/... paths.",
      "The first research wave uses mode discovery and mutually exclusive assignmentIds. A supplement must use mode supplement and resolvesIds for explicit unresolved gap, conflict, or failure IDs; do not repeat broad research.",
    ],
    parameters: Type.Object({ tasks: Type.Array(delegateTaskSchema, { minItems: 1 }) }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      const result = await start((params as { tasks: WikiLeadDelegateTask[] }).tasks);
      return toolResult(result);
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateCollectTool(
  collect: (batchId: number, options: { until: "any" | "all"; timeoutSeconds: number }) => Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_collect",
    label: "Collect Wiki tasks",
    description: "Collect completed receipts from an asynchronous Wiki task batch, optionally waiting for any or all pending tasks.",
    promptSnippet: "Collect receipts from a started Wiki task batch",
    promptGuidelines: ["Use timeoutSeconds 0 for a non-blocking status check."],
    parameters: Type.Object({
      batchId: Type.Integer({ minimum: 1 }),
      until: StringEnum(["any", "all"]),
      timeoutSeconds: Type.Integer({ minimum: 0, maximum: 60 }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        const input = params as { batchId: number; until: "any" | "all"; timeoutSeconds: number };
        return toolResult(await collect(input.batchId, { until: input.until, timeoutSeconds: input.timeoutSeconds }));
      } catch (error) {
        rejectWikiTool("wiki_delegate_collect", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiDelegateCancelTool(
  cancel: (batchId: number, taskIds?: string[], reason?: string) => Promise<unknown>,
): ToolDefinition<any, any, any> {
  return {
    name: "wiki_delegate_cancel",
    label: "Cancel Wiki tasks",
    description: "Cancel pending tasks in an asynchronous Wiki batch, or cancel the whole batch when taskIds is omitted.",
    promptSnippet: "Cancel no-longer-useful Wiki tasks",
    parameters: Type.Object({
      batchId: Type.Integer({ minimum: 1 }),
      taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        const input = params as { batchId: number; taskIds?: string[]; reason?: string };
        return toolResult(await cancel(input.batchId, input.taskIds, input.reason));
      } catch (error) {
        rejectWikiTool("wiki_delegate_cancel", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiFinishTool(finish: (summary: string) => unknown | Promise<unknown>): ToolDefinition<any, any, any> {
  return {
    name: "wiki_finish",
    label: "Finish Wiki workflow",
    description: "Finish after the candidate Wiki is complete and sufficiently grounded.",
    promptSnippet: "Finish after the candidate Wiki is complete and reviewed",
    promptGuidelines: [
      "Call wiki_finish only after an accepted WikiSpec and current passing independent reviews.",
      "wiki_finish summary must be 1-1024 characters.",
    ],
    parameters: Type.Object({
      summary: Type.String({
        minLength: 1,
        maxLength: 1024,
        description: "Concise completion summary for the accepted Wiki",
      }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      try {
        return toolResult(await finish((params as { summary: string }).summary));
      } catch (error) {
        rejectWikiTool("wiki_finish", error);
      }
    },
  } as ToolDefinition<any, any, any>;
}

export function createWikiReviewFinishTool(finish: (result: WikiReviewResult) => void): ToolDefinition<any, any, any> {
  return {
    name: "wiki_review_finish",
    label: "Finish Wiki review",
    description: "Submit the independent structured verdict for every assigned candidate path and required profile review item.",
    promptSnippet: "Submit the independent structured review verdict",
    promptGuidelines: [
      "wiki_review_finish reviewedPaths must exactly match the assigned reviewPaths.",
    ],
    parameters: Type.Object({
      verdict: StringEnum(["pass", "changes_requested"], { description: "Independent review verdict for the assigned paths" }),
      reviewedPaths: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
        description: "Exact assigned reviewPaths that were reviewed",
      }),
      findings: Type.Array(reviewFindingSchema, { description: "Issues found on assigned paths" }),
      profileCoverage: Type.Array(Type.String({ minLength: 1 }), { description: "Generation-profile review items covered" }),
    }, { additionalProperties: false }),
    constrainedSampling: JSON_SCHEMA_PREFER,
    async execute(_id, params) {
      finish(params as WikiReviewResult);
      return toolResult({ accepted: true });
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
