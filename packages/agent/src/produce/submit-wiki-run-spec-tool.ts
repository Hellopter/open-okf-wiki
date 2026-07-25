/**
 * Run Boundary planner tool: validate WikiRunSpec and atomically write plan-draft.json.
 * Path-first handoff (ADR 0011) — control returns a short ACK + path, not the full Spec.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type WikiRunSpec, WikiRunSpecSchema } from "@okf-wiki/contract";
import { PLAN_DRAFT_REL_PATH, writePlanDraft } from "./living-spec.js";

export const SUBMIT_WIKI_RUN_SPEC_TOOL_NAME = "submit_wiki_run_spec" as const;

const domainSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 80 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scope: Type.String({ minLength: 1, maxLength: 2000 }),
    critical: Type.Optional(Type.Boolean()),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }))),
  },
  { additionalProperties: false },
);

const pageSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 200 }),
    purpose: Type.String({ minLength: 1, maxLength: 500 }),
    domainIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }))),
    template: Type.Optional(
      Type.Union([
        Type.Literal("overview"),
        Type.Literal("architecture"),
        Type.Literal("module"),
        Type.Literal("flow"),
        Type.Literal("concept"),
      ]),
    ),
    critical: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const acceptanceSchema = Type.Object(
  {
    reviewRequired: Type.Optional(Type.Boolean()),
    maxRepairRounds: Type.Optional(Type.Number()),
    blockingSeverities: Type.Optional(
      Type.Array(
        Type.Union([Type.Literal("blocking"), Type.Literal("major"), Type.Literal("minor")]),
      ),
    ),
  },
  { additionalProperties: false },
);

/** TypeBox surface for the planner; Zod WikiRunSpecSchema is the truth gate. */
export const submitWikiRunSpecParameters = Type.Object(
  {
    version: Type.Optional(Type.Literal(1)),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    audience: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    domains: Type.Array(domainSchema),
    pages: Type.Array(pageSchema, { minItems: 1 }),
    openQuestions: Type.Optional(Type.Array(Type.String({ maxLength: 500 }))),
    acceptance: Type.Optional(acceptanceSchema),
    notes: Type.Optional(Type.String({ maxLength: 4000 })),
    changelog: Type.Optional(Type.Array(Type.String({ maxLength: 500 }))),
  },
  { additionalProperties: false },
);

export type SubmitWikiRunSpecDetails = {
  specPath: string;
  absolutePath: string;
  pageCount: number;
  domainCount: number;
  summary: string;
};

export type CreateSubmitWikiRunSpecToolInput = {
  runWorkDir: string;
  /** Optional test hook; defaults to writePlanDraft. */
  writeDraft?: (runWorkDir: string, spec: WikiRunSpec) => Promise<string>;
};

export function createSubmitWikiRunSpecTool(
  input: CreateSubmitWikiRunSpecToolInput,
): ToolDefinition<typeof submitWikiRunSpecParameters, SubmitWikiRunSpecDetails> {
  const writeDraft = input.writeDraft ?? writePlanDraft;
  return defineTool({
    name: SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
    label: "Submit WikiRunSpec",
    description: [
      "Submit the complete living WikiRunSpec after inspecting frozen sources.",
      "Product validates the Spec and writes analysis/plan-draft.json under the Run Boundary.",
      "Call exactly once when the plan is ready. Do not write wiki pages.",
    ].join(" "),
    promptSnippet: "Submit complete WikiRunSpec (writes analysis/plan-draft.json)",
    promptGuidelines: [
      "After read-only source inspection, call submit_wiki_run_spec with the full WikiRunSpec fields.",
      "Do not paste the full Spec as chat text; the tool is the handoff.",
      "Always include a critical overview.md page; do not list index.md as a concept page.",
    ],
    parameters: submitWikiRunSpecParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const parsed = WikiRunSpecSchema.safeParse(params);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue
          ? `${issue.path.join(".") || "spec"}: ${issue.message}`
          : "invalid Spec";
        throw new Error(`submit_wiki_run_spec rejected: ${where}`);
      }
      const absolutePath = await writeDraft(input.runWorkDir, parsed.data);
      const details: SubmitWikiRunSpecDetails = {
        specPath: PLAN_DRAFT_REL_PATH,
        absolutePath,
        pageCount: parsed.data.pages.length,
        domainCount: parsed.data.domains.length,
        summary: parsed.data.summary.slice(0, 200),
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `WikiRunSpec accepted: ${details.pageCount} page(s), ${details.domainCount} domain(s) → ${PLAN_DRAFT_REL_PATH}`,
          },
        ],
        details,
      };
    },
  });
}
