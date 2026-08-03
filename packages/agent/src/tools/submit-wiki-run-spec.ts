/**
 * Run Boundary planner tool: validate WikiRunSpec and atomically write plan-draft.json.
 * Path-first handoff (ADR 0011) — control returns a short ACK + path, not the full Spec.
 * When a CoveragePlan is available (injected or on disk), assertCoverage runs fail-closed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertCoverage,
  assertSpecWithinFanOutCaps,
  type CoveragePlan,
  CoverageAssertError,
  parseSealedCoveragePlan,
  SpecFanOutCapError,
  type SpecFanOutCaps,
  SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
  type WikiRunSpec,
  WikiRunSpecSchema,
} from "@okf-wiki/contract";
import { defaultSpecStore, PLAN_DRAFT_REL_PATH } from "../ports/core-spec-store.js";

export { SUBMIT_WIKI_RUN_SPEC_TOOL_NAME };

/** Load sealed coverage plan from run workdir (inputs/ preferred, then analysis/). */
async function loadCoveragePlanFromWorkdir(
  runWorkDir: string,
): Promise<CoveragePlan | undefined> {
  for (const rel of ["inputs/coverage-plan.json", "analysis/coverage-plan.json"]) {
    try {
      const raw = JSON.parse(await readFile(path.join(runWorkDir, rel), "utf8")) as unknown;
      // Strip freeze host extras (lightPath/reasons/maxSurfacesRequired).
      const parsed = parseSealedCoveragePlan(raw);
      if (parsed) return parsed;
    } catch {
      // try next path
    }
  }
  return undefined;
}

const coverageBindings = {
  coverageUnitIds: Type.Optional(
    Type.Array(
      Type.String({
        description:
          "Canonical coverage unit ids: bare sourceId or source-qualified surface `{sourceId}::{path}`.",
        minLength: 1,
        maxLength: 400,
      }),
      { maxItems: 64 },
    ),
  ),
  sourceIds: Type.Optional(
    Type.Array(
      Type.String({
        description: "Projection: whole freeze source ids this domain/page covers.",
        minLength: 1,
        maxLength: 80,
      }),
      { maxItems: 64 },
    ),
  ),
  surfaceIds: Type.Optional(
    Type.Array(
      Type.String({
        description: "Projection: source-qualified surface ids `{sourceId}::{path}`.",
        minLength: 1,
        maxLength: 400,
      }),
      { maxItems: 64 },
    ),
  ),
};

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
    ...coverageBindings,
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
          description:
            "Optional page template hint: overview | architecture | module | flow | concept.",
        },
      ),
    ),
    critical: Type.Optional(
      Type.Boolean({
        description: "When true, page is required (always mark overview.md critical).",
      }),
    ),
    ...coverageBindings,
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
        description:
          "Max hard-validate repair rounds (non-negative number). Omit for product default.",
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
      description:
        "Domain breakdown of the sources (may be empty only if pages fully stand alone).",
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
    repositoryMap: Type.Optional(
      Type.Object(
        {
          summary: Type.Optional(
            Type.String({
              description: "Narrative map of freeze sources / roles (max 4000 chars).",
              maxLength: 4000,
            }),
          ),
          sources: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  sourceId: Type.String({ minLength: 1, maxLength: 80 }),
                  role: Type.Optional(Type.String({ maxLength: 500 })),
                  entryPoints: Type.Optional(
                    Type.Array(Type.String({ maxLength: 300 }), { maxItems: 32 }),
                  ),
                },
                { additionalProperties: false },
              ),
              { maxItems: 64 },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    sourceCoverage: Type.Optional(
      Type.Array(
        Type.Object(
          {
            sourceId: Type.String({ minLength: 1, maxLength: 80 }),
            pagePaths: Type.Optional(
              Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 }),
            ),
            notes: Type.Optional(
              Type.String({
                description:
                  "Optional audit notes; required cancel reason when cancelled is true.",
                maxLength: 1000,
              }),
            ),
            cancelled: Type.Optional(
              Type.Boolean({
                description:
                  "When true, cancel this source unit for assertCoverage (notes required as reason).",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 64 },
      ),
    ),
    surfaceCoverage: Type.Optional(
      Type.Array(
        Type.Object(
          {
            surfaceId: Type.String({
              description: "Source-qualified surface id `{sourceId}::{path}`.",
              minLength: 1,
              maxLength: 400,
            }),
            pagePaths: Type.Optional(
              Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 }),
            ),
            notes: Type.Optional(
              Type.String({
                description:
                  "Optional audit notes; required cancel reason when cancelled is true.",
                maxLength: 1000,
              }),
            ),
            cancelled: Type.Optional(
              Type.Boolean({
                description:
                  "When true, cancel this surface unit for assertCoverage (notes required as reason).",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 256 },
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
  /**
   * Topology fan-out caps (from adaptive orchestration). When set, over-cap
   * Specs are rejected at tool time so the planner can fix in-session.
   * Host compile remains fail-closed as defense in depth.
   */
  caps?: SpecFanOutCaps;
  /**
   * Coverage plan for assertCoverage. When omitted, the tool loads
   * analysis/coverage-plan.json or inputs/coverage-plan.json when present.
   */
  coveragePlan?: CoveragePlan;
  /** Optional test hook; defaults to defaultSpecStore.writePlanDraft. */
  writeDraft?: (runWorkDir: string, spec: WikiRunSpec) => Promise<string>;
  /** Optional test hook for loading coverage plan from disk. */
  loadCoveragePlan?: (runWorkDir: string) => Promise<CoveragePlan | undefined>;
};

export function createSubmitWikiRunSpecTool(
  input: CreateSubmitWikiRunSpecToolInput,
): ToolDefinition<typeof submitWikiRunSpecParameters, SubmitWikiRunSpecDetails> {
  const writeDraft =
    input.writeDraft ?? ((dir, spec) => defaultSpecStore.writePlanDraft(dir, spec));
  const loadPlan =
    input.loadCoveragePlan ?? ((dir) => loadCoveragePlanFromWorkdir(dir));
  return defineTool({
    name: SUBMIT_WIKI_RUN_SPEC_TOOL_NAME,
    label: "Submit WikiRunSpec",
    description: [
      "Submit the complete living WikiRunSpec after read-only inspection of frozen sources.",
      "Product validates the Spec (including coverage unit bindings when a CoveragePlan is sealed)",
      "and atomically writes analysis/plan-draft.json under the Run Boundary (path-first handoff).",
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
      "Bind required coverage units on critical pages via coverageUnitIds (or sourceIds / surfaceIds).",
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
      try {
        assertSpecWithinFanOutCaps(parsed.data, input.caps);
      } catch (err) {
        if (err instanceof SpecFanOutCapError) {
          throw new Error(`submit_wiki_run_spec rejected: ${err.message}`);
        }
        throw err;
      }

      const plan = input.coveragePlan ?? (await loadPlan(input.runWorkDir));
      if (plan && plan.requiredUnits.length > 0) {
        try {
          assertCoverage(parsed.data, plan, { throwOnGap: true });
        } catch (err) {
          if (err instanceof CoverageAssertError) {
            const gaps = err.result.gaps.slice(0, 12).join(", ");
            throw new Error(
              `submit_wiki_run_spec rejected: coverage gap — ${err.message}. ` +
                `Missing units: ${gaps || "(see plan)"}. ` +
                "Bind each required unit on a critical page via coverageUnitIds / sourceIds / surfaceIds, " +
                "or cancel via sourceCoverage/surfaceCoverage with cancelled:true and notes reason, " +
                "then resubmit the complete Spec.",
            );
          }
          throw err;
        }
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
