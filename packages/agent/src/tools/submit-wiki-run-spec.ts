/**
 * Run Boundary planner tool: validate WikiRunSpec and atomically write plan-draft.json.
 * Path-first handoff (ADR 0011) — control returns a short ACK + path, not the full Spec.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import { defaultSpecStore, PLAN_DRAFT_REL_PATH } from "../ports/core-spec-store.js";

export { SUBMIT_WIKI_RUN_SPEC_TOOL_NAME };

const domainSchema = Type.Object(
  {
    id: Type.String({
      description: "Stable domain id (1–80 chars), referenced by pages.domainIds.",
      minLength: 1,
      maxLength: 80,
    }),
    title: Type.String({
      description: "Human-readable domain title (1–200 chars).",
      minLength: 1,
      maxLength: 200,
    }),
    scope: Type.String({
      description: "What this domain covers in the sources (1–2000 chars).",
      minLength: 1,
      maxLength: 2000,
    }),
    critical: Type.Optional(
      Type.Boolean({
        description: "When true, treat this domain as must-cover for the plan.",
      }),
    ),
    questions: Type.Optional(
      Type.Array(
        Type.String({
          description: "Investigation question for this domain (1–500 chars each).",
          minLength: 1,
          maxLength: 500,
        }),
      ),
    ),
  },
  { additionalProperties: false },
);

const pageSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Wiki-relative page path (1–200 chars), e.g. overview.md or modules/foo.md. " +
        "Do not list index.md or log.md — those are product-generated.",
      minLength: 1,
      maxLength: 200,
    }),
    purpose: Type.String({
      description: "Why this page exists and what it must explain (1–500 chars).",
      minLength: 1,
      maxLength: 500,
    }),
    domainIds: Type.Optional(
      Type.Array(
        Type.String({
          description: "Domain id from domains[].id that this page covers.",
          minLength: 1,
        }),
      ),
    ),
    questions: Type.Optional(
      Type.Array(
        Type.String({
          description: "Page-level question the write step should answer (1–500 chars).",
          minLength: 1,
          maxLength: 500,
        }),
      ),
    ),
    template: Type.Optional(
      Type.Union(
        [
          Type.Literal("overview"),
          Type.Literal("architecture"),
          Type.Literal("module"),
          Type.Literal("flow"),
          Type.Literal("concept"),
        ],
        {
          description: "Optional page template hint: overview | architecture | module | flow | concept.",
        },
      ),
    ),
    critical: Type.Optional(
      Type.Boolean({
        description: "When true, page is required (always mark overview.md critical).",
      }),
    ),
  },
  { additionalProperties: false },
);

const acceptanceSchema = Type.Object(
  {
    reviewRequired: Type.Optional(
      Type.Boolean({ description: "Whether human/reviewer gate is required before publish." }),
    ),
    maxRepairRounds: Type.Optional(
      Type.Number({
        description: "Max soft repair rounds (non-negative number). Omit for product default.",
      }),
    ),
    maxHardValidateRepairRounds: Type.Optional(
      Type.Number({
        description: "Max hard-validate repair rounds (non-negative number). Omit for product default.",
      }),
    ),
    blockingSeverities: Type.Optional(
      Type.Array(
        Type.Union([Type.Literal("blocking"), Type.Literal("major"), Type.Literal("minor")], {
          description: "Severity that blocks acceptance: blocking | major | minor.",
        }),
      ),
    ),
  },
  { additionalProperties: false },
);

/** TypeBox surface for the planner; Zod WikiRunSpecSchema is the truth gate. */
export const submitWikiRunSpecParameters = Type.Object(
  {
    version: Type.Optional(
      Type.Literal(1, { description: "Spec schema version; only 1 is accepted. Defaults to 1." }),
    ),
    summary: Type.String({
      description: "One-paragraph plan summary for the operator (1–4000 chars).",
      minLength: 1,
      maxLength: 4000,
    }),
    audience: Type.Optional(
      Type.String({
        description: "Intended reader of the Wiki (1–1000 chars).",
        minLength: 1,
        maxLength: 1000,
      }),
    ),
    domains: Type.Array(domainSchema, {
      description: "Domain breakdown of the sources (may be empty only if pages fully stand alone).",
    }),
    pages: Type.Array(pageSchema, {
      minItems: 1,
      description:
        "Planned wiki pages (min 1). Always include a critical overview.md; " +
        "prefer modules/, flows/ (and deeper) for related concepts. Never list index.md or log.md.",
    }),
    openQuestions: Type.Optional(
      Type.Array(
        Type.String({
          description: "Unresolved question to surface in the plan (max 500 chars each).",
          maxLength: 500,
        }),
      ),
    ),
    acceptance: Type.Optional(acceptanceSchema),
    notes: Type.Optional(
      Type.String({
        description: "Planner notes for later phases (max 4000 chars). Not a substitute for pages.",
        maxLength: 4000,
      }),
    ),
    changelog: Type.Optional(
      Type.Array(
        Type.String({
          description: "Short changelog entry for this Spec revision (max 500 chars each).",
          maxLength: 500,
        }),
      ),
    ),
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
  /** Optional test hook; defaults to defaultSpecStore.writePlanDraft. */
  writeDraft?: (runWorkDir: string, spec: WikiRunSpec) => Promise<string>;
};

export function createSubmitWikiRunSpecTool(
  input: CreateSubmitWikiRunSpecToolInput,
): ToolDefinition<typeof submitWikiRunSpecParameters, SubmitWikiRunSpecDetails> {
  const writeDraft =
    input.writeDraft ?? ((dir, spec) => defaultSpecStore.writePlanDraft(dir, spec));
  return defineTool({
    name: SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
    label: "Submit WikiRunSpec",
    description: [
      "Submit the complete living WikiRunSpec after read-only inspection of frozen sources.",
      "Product validates the Spec and atomically writes analysis/plan-draft.json under the Run Boundary (path-first handoff).",
      "Call exactly once when the plan is ready.",
      "",
      "When to use:",
      "- Plan Attempt: sources inspected, domains/pages decided, ready to hand off the full Spec.",
      "- After fixing a prior rejection: resubmit the complete corrected Spec (not a partial patch as chat).",
      "",
      "Do not use when:",
      "- Still exploring sources — keep using read-only tools until the plan is complete.",
      "- You want to write wiki page bodies — writers own that after the Spec is accepted; this tool only records the plan.",
      "- Pasting Spec JSON into chat — the tool is the handoff; do not dump the full Spec as assistant text.",
      "- Listing index.md or log.md as pages — those are product-generated progressive-disclosure indexes.",
    ].join("\n"),
    promptSnippet: "Submit complete WikiRunSpec (writes analysis/plan-draft.json)",
    promptGuidelines: [
      "After read-only source inspection, call submit_wiki_run_spec with the full WikiRunSpec fields.",
      "Do not paste the full Spec as chat text; the tool is the handoff.",
      "Always include a critical overview.md page; prefer modules/, flows/ (and deeper) directory layout for related concepts.",
      "Do not list index.md or log.md as Spec pages — indexes are mechanical progressive-disclosure listings regenerated by the product.",
      "On rejection, fix the named field and call submit_wiki_run_spec again with a complete Spec — do not write wiki pages to work around validation.",
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
        throw new Error(
          `submit_wiki_run_spec rejected: ${where}. ` +
            "Fix the named field(s) and call again with a complete WikiRunSpec " +
            "(pages min 1, include critical overview.md; never index.md/log.md). " +
            "Do not write wiki page bodies or bypass via bash.",
        );
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
