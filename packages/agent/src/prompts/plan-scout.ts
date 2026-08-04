/**
 * Hybrid plan-scout prompts (MoA proposers before Spec synthesizer).
 *
 * Task kinds / selection live in `@okf-wiki/contract/wiki-runs` so workflow
 * freeze materialization does not import agent. This module owns prompt text.
 *
 * Doctrine: implementation evidence (not README-only); structured report file
 * body via final message; short ACK — sealed analysis/plan-scouts/* is authority.
 */

export {
  PLAN_SCOUT_KINDS,
  type PlanScoutKind,
  type PlanScoutTask,
  planScoutNodeKey,
  scoutTaskFileSlug,
  scoutTaskLabel,
  THEMATIC_SCOUT_KINDS,
  type ThematicScoutKind,
} from "@okf-wiki/contract/wiki-runs";

import type { PlanScoutTask, ThematicScoutKind } from "@okf-wiki/contract/wiki-runs";

const TOOLS_LINE =
  "Use only read tools (ls, find, grep, read). Do not write wiki pages. Do not use bash. Do not submit a Spec.";

const SHORT_ACK =
  "Final message doctrine: return only the structured report below (prefer paths over prose). " +
  "Keep under the word budget. Sealed analysis/plan-scouts/* is the durable authority; chat is not.";

function semanticKindOf(task: PlanScoutTask): "domain" | "flow" | "concept" | undefined {
  const k = task.kind as string;
  if (k === "domain" || k === "flow" || k === "concept") return k;
  return undefined;
}

function sourceSurveyPrompt(input: {
  workspaceName: string;
  sourceId: string;
  notes: string;
}): string {
  const sid = input.sourceId;
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    `Scout focus: SOURCE SURVEY for freeze source "${sid}".`,
    `Inspect under sources/${sid}/ — go beyond README:`,
    "- package/build manifests (package.json, pyproject, go.mod, Cargo.toml, …)",
    "- public entrypoints (bin/, main modules, exported APIs, HTTP/router mounts)",
    "- implementation roots (src/, lib/, app/, cmd/, internal/ as present)",
    "- tests/fixtures that reveal intended contracts",
    "- cross-links to other sources/ only if this source imports/calls them",
    "Do not deep-dive other sources in this scout — they have their own surveys.",
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    `## Source: ${sid}`,
    "- purpose / role of this repository (one sentence, evidence-backed)",
    "- entry points (concrete paths under sources/" + sid + "/ with tool-derived lines when known)",
    "- implementation evidence (key modules/packages and what they own — not README paraphrase)",
    "- notable packages or surfaces",
    "- suggested wiki pages that must mention this source",
    "- open questions",
    "",
    SHORT_ACK,
    "Keep under ~600 words.",
    `Bind this source later via coverageUnitIds or sourceIds including "${sid}".`,
  ]
    .filter(Boolean)
    .join("\n");
}

function surfaceSurveyPrompt(input: {
  workspaceName: string;
  sourceId: string;
  surfacePath: string;
  unitId: string;
  notes: string;
}): string {
  const { sourceId, surfacePath, unitId } = input;
  const mount =
    surfacePath === "."
      ? `sources/${sourceId}/`
      : `sources/${sourceId}/${surfacePath}/`;
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    `Scout focus: SURFACE SURVEY for unit "${unitId}".`,
    `Inspect primarily under ${mount}:`,
    "- manifests and entrypoints",
    "- public boundaries and exports",
    "- implementation files that define this surface's behavior (not README-only)",
    "- how it relates to sibling surfaces under the same source",
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    `## Surface: ${unitId}`,
    "- what this package/app/docs root owns",
    "- entry points and public boundaries (paths + line ranges when known)",
    "- implementation evidence (concrete modules/handlers)",
    "- sibling surface relationships",
    "- suggested wiki pages for this surface",
    "- open questions",
    "",
    SHORT_ACK,
    "Keep under ~500 words.",
    `Bind this surface later via coverageUnitIds or surfaceIds including "${unitId}".`,
  ]
    .filter(Boolean)
    .join("\n");
}

function semanticSurveyPrompt(input: {
  workspaceName: string;
  kind: "domain" | "flow" | "concept";
  notes: string;
}): string {
  const focus = {
    domain: [
      "Scout focus: SEMANTIC DOMAINS.",
      "Identify independent reader/evidence domains (ownership boundaries, not one domain per file).",
      "Ground each candidate domain in implementation paths under sources/ (packages, services, modules).",
      "Multi-source: name which sources/<id>/ each domain spans.",
    ].join(" "),
    flow: [
      "Scout focus: SEMANTIC FLOWS.",
      "Trace important runtime or request/data flows across modules or sources.",
      "Prefer call paths, handlers, pipelines, and integration seams over marketing docs.",
      "Flag cross-source flows when sources integrate.",
    ].join(" "),
    concept: [
      "Scout focus: SEMANTIC CONCEPTS.",
      "Surface load-bearing domain terms and abstractions a new reader must learn.",
      "Each concept needs implementation evidence paths (types, configs, primary modules) — not glossary fluff.",
    ].join(" "),
  }[input.kind];

  const sections = {
    domain: [
      "## Candidate domains",
      "- id/title, scope, coverage unit ids or source ids, evidence paths",
      "## Suggested pages",
      "- wiki page paths + one-line purpose per domain",
      "## Open questions",
    ],
    flow: [
      "## Candidate flows",
      "- id/title, ordered steps (path or module names), crossSource yes/no, evidence paths",
      "## Suggested pages",
      "- flow/*.md candidates + purpose",
      "## Open questions",
    ],
    concept: [
      "## Candidate concepts",
      "- term, one-line definition hint, evidence paths",
      "## Suggested pages",
      "- concept page candidates when a term needs its own page",
      "## Open questions",
    ],
  }[input.kind];

  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    focus,
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    ...sections,
    "",
    SHORT_ACK,
    "Keep under ~700 words. Prefer paths over prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

function thematicSurveyPrompt(input: {
  workspaceName: string;
  thematic: ThematicScoutKind;
  notes: string;
}): string {
  const focus = {
    entry: [
      "Scout focus: ENTRY POINTS.",
      "Inspect README, package manifests (package.json, pyproject, go.mod, Cargo.toml, pom.xml),",
      "binaries/CLIs, main modules, and documented quickstarts under sources/.",
      "Also open implementation entry files (not README alone).",
      "When multiple sources/ exist, note entry points per source — do not only report the first mount.",
      "List concrete paths a reader should learn first.",
    ].join(" "),
    layout: [
      "Scout focus: REPOSITORY LAYOUT.",
      "Map top-level directories, major packages/apps, and boundaries between them.",
      "For multi-source freezes, map each sources/<id>/; for monorepos, list package surfaces.",
      "Note which areas look independent enough to become Wiki domains — ground with paths.",
    ].join(" "),
    tests: [
      "Scout focus: TESTS & INTENDED BEHAVIOR.",
      "Find test roots and high-signal fixtures that reveal contracts and edge cases.",
      "Do not treat tests as noise — they are evidence of intended behavior.",
      "Cite concrete test file paths.",
    ].join(" "),
    risks: [
      "Scout focus: RISKS & GAPS.",
      "Call out ambiguous ownership, generated code, vendor trees, missing docs,",
      "or areas that would confuse a new reader if omitted from the wiki.",
      "Flag any freeze source or package surface that looks under-surveyed.",
    ].join(" "),
  }[input.thematic];

  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    focus,
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report (markdown is fine) with sections:",
    "## Findings",
    "- bullet list of concrete repo-relative paths and why they matter (implementation evidence)",
    "## Suggested domains",
    "- short ids/titles for independent evidence areas (or none)",
    "## Suggested pages",
    "- candidate wiki page paths + one-line purpose (overview.md should appear if entry is clear)",
    "## Open questions",
    "- unknowns the planner must still resolve",
    "",
    SHORT_ACK,
    "Keep under ~800 words. Prefer paths over prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function planScoutPrompt(input: {
  task: PlanScoutTask;
  workspaceName: string;
  operatorNotes?: string;
}): string {
  const notes = input.operatorNotes?.trim()
    ? `Operator focus (respect when relevant):\n${input.operatorNotes.trim()}`
    : "";

  if (input.task.kind === "source") {
    return sourceSurveyPrompt({
      workspaceName: input.workspaceName,
      sourceId: input.task.sourceId,
      notes,
    });
  }

  if (input.task.kind === "surface") {
    return surfaceSurveyPrompt({
      workspaceName: input.workspaceName,
      sourceId: input.task.sourceId,
      surfacePath: input.task.path,
      unitId: input.task.unitId,
      notes,
    });
  }

  const semantic = semanticKindOf(input.task);
  if (semantic) {
    return semanticSurveyPrompt({
      workspaceName: input.workspaceName,
      kind: semantic,
      notes,
    });
  }

  if (input.task.kind === "thematic") {
    return thematicSurveyPrompt({
      workspaceName: input.workspaceName,
      thematic: input.task.thematic,
      notes,
    });
  }

  // Fallback for future task kinds from contract.
  const kind = (input.task as { kind?: string }).kind ?? "unknown";
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    `Scout focus: ${kind}.`,
    "Inspect sources/ for implementation evidence relevant to this focus.",
    TOOLS_LINE,
    notes,
    "",
    "Return a compact structured report with Findings, Suggested pages, Open questions.",
    SHORT_ACK,
    "Keep under ~600 words.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Back-compat wrapper for thematic-only callers.
 * @deprecated Prefer planScoutPrompt({ task, ... }) with a PlanScoutTask.
 */
export function planScoutPromptLegacy(input: {
  kind: ThematicScoutKind;
  workspaceName: string;
  operatorNotes?: string;
}): string {
  return planScoutPrompt({
    task: {
      kind: "thematic",
      thematic: input.kind,
      id: input.kind,
      required: false,
    },
    workspaceName: input.workspaceName,
    operatorNotes: input.operatorNotes,
  });
}
