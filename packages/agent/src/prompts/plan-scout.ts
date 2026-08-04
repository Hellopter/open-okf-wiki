/**
 * Hybrid plan-scout prompts (MoA proposers before Spec synthesizer).
 *
 * Task kinds / selection live in `@okf-wiki/contract/wiki-runs` so workflow
 * freeze materialization does not import agent. This module owns prompt text.
 *
 * Doctrine: implementation evidence (not README-only); structured report file
 * body via final message; short ACK — sealed analysis/plan-scouts/* is authority.
 *
 * Semantic scouts are source-qualified after WP2:
 * - domain:{sourceId} / flow:{sourceId} / concept:{sourceId} — stay under sources/{id}/
 * - flow:cross (task.cross or sourceId "cross") — cross-repo contracts only
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

type SemanticKind = "domain" | "flow" | "concept";

function semanticKindOf(task: PlanScoutTask): SemanticKind | undefined {
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

/** Per-source domain scout: stay under sources/{sourceId}/. */
function domainSourcePrompt(input: {
  workspaceName: string;
  sourceId: string;
  notes: string;
}): string {
  const sid = input.sourceId;
  const mount = `sources/${sid}/`;
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    `Scout focus: SEMANTIC DOMAINS for freeze source "${sid}" only.`,
    `Stay under ${mount}. Do not survey other sources/ mounts — they have their own domain scouts.`,
    "Identify independent reader/evidence domains (ownership boundaries, not one domain per file).",
    "Ground every candidate in implementation paths (packages, services, modules, handlers) — not README paraphrase.",
    "Prefer ≥3 non-README evidence paths per domain when the tree allows (manifests + src + tests count).",
    "Emit at most 5 domain candidates; merge thin slices rather than inventing filler.",
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    `## Source: ${sid}`,
    "## Candidate domains (≤5)",
    `- For each: id, title, scope, coverageUnitIds (include "${sid}"), evidencePaths (≥3 non-README under ${mount} when possible), readerQuestion`,
    "## Suggested pages",
    "- wiki page paths + one-line purpose per domain",
    "## Open questions",
    "",
    SHORT_ACK,
    "Keep under ~700 words. Prefer paths over prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Per-source flow scout: critical paths inside one source. */
function flowSourcePrompt(input: {
  workspaceName: string;
  sourceId: string;
  notes: string;
}): string {
  const sid = input.sourceId;
  const mount = `sources/${sid}/`;
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    `Scout focus: SEMANTIC FLOWS for freeze source "${sid}" only.`,
    `Stay under ${mount}. Trace critical runtime/request/data paths inside this source.`,
    "Prefer call paths, handlers, pipelines, and internal integration seams over marketing docs.",
    "Do not invent cross-repo journeys here — a separate flow:cross scout owns multi-source contracts.",
    "Mark crossSource: false for in-source flows.",
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    `## Source: ${sid}`,
    "## Candidate flows",
    `- For each: id, title, ordered steps (module/path names under ${mount}), crossSource: false, coverageUnitIds (include "${sid}"), evidencePaths (implementation, not README-only)`,
    "## Suggested pages",
    "- flow/*.md candidates + purpose",
    "## Open questions",
    "",
    SHORT_ACK,
    "Keep under ~700 words. Prefer paths over prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Multi-source cross-flow scout: contracts/APIs/events across sources only. */
function flowCrossPrompt(input: {
  workspaceName: string;
  notes: string;
}): string {
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    "Scout focus: CROSS-SOURCE FLOWS (flow:cross).",
    "Only document contracts that cross freeze sources: HTTP/RPC APIs, shared events/queues, auth handshakes, shared schemas, or deploy-time wiring.",
    "Do not re-list in-source call graphs — per-source flow scouts own those.",
    "Each cross-source flow must name participating sources and cite evidence paths under at least two sources/<id>/ mounts.",
    "Mark crossSource: true. Steps should be ordered and source-qualified (e.g. web form → api token handler).",
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    "## Candidate cross-source flows",
    "- For each: id, title, ordered steps (source-qualified), crossSource: true, coverageUnitIds (all participating source ids), evidencePaths (non-empty; both/all sources)",
    "## Integration seams",
    "- API/event/schema boundaries with concrete paths",
    "## Open questions",
    "- Unknown joins the planner must still resolve (explicit openQuestion if no cross flow is evidenced)",
    "",
    SHORT_ACK,
    "Keep under ~700 words. Prefer paths over prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Per-source concept scout (optional / soft). */
function conceptSourcePrompt(input: {
  workspaceName: string;
  sourceId: string;
  notes: string;
}): string {
  const sid = input.sourceId;
  const mount = `sources/${sid}/`;
  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    `Scout focus: SEMANTIC CONCEPTS for freeze source "${sid}".`,
    `Prefer ${mount}; only mention other sources when a term is defined by a shared contract.`,
    "Surface load-bearing domain terms and abstractions a new reader must learn for this source.",
    "Each concept needs implementation evidence paths (types, configs, primary modules) — not glossary fluff.",
    TOOLS_LINE,
    input.notes,
    "",
    "Return a compact structured report with sections:",
    `## Source: ${sid}`,
    "## Candidate concepts",
    "- term, one-line definition hint, evidencePaths under " + mount,
    "## Suggested pages",
    "- concept page candidates when a term needs its own page",
    "## Open questions",
    "",
    SHORT_ACK,
    "Keep under ~600 words. Prefer paths over prose.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Legacy bare global semantic (compat for pre-WP2 nodes without sourceId). */
function semanticGlobalPrompt(input: {
  workspaceName: string;
  kind: SemanticKind;
  notes: string;
}): string {
  const focus = {
    domain: [
      "Scout focus: SEMANTIC DOMAINS (global / legacy).",
      "Identify independent reader/evidence domains (ownership boundaries, not one domain per file).",
      "Ground each candidate domain in implementation paths under sources/ (packages, services, modules).",
      "Multi-source: name which sources/<id>/ each domain spans; prefer per-source domain:{id} scouts when available.",
    ].join(" "),
    flow: [
      "Scout focus: SEMANTIC FLOWS (global / legacy).",
      "Trace important runtime or request/data flows across modules or sources.",
      "Prefer call paths, handlers, pipelines, and integration seams over marketing docs.",
      "Flag cross-source flows when sources integrate; prefer flow:{id} + flow:cross when available.",
    ].join(" "),
    concept: [
      "Scout focus: SEMANTIC CONCEPTS (global / legacy).",
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

function semanticSurveyPrompt(input: {
  workspaceName: string;
  kind: SemanticKind;
  notes: string;
  /** Per-source qualifier when task is source-qualified. */
  sourceId?: string;
  /** True for multi-source cross-flow scout. */
  cross?: boolean;
}): string {
  const { kind, sourceId, cross } = input;

  if (kind === "flow" && (cross === true || sourceId === "cross")) {
    return flowCrossPrompt({
      workspaceName: input.workspaceName,
      notes: input.notes,
    });
  }

  if (sourceId && sourceId !== "cross") {
    if (kind === "domain") {
      return domainSourcePrompt({
        workspaceName: input.workspaceName,
        sourceId,
        notes: input.notes,
      });
    }
    if (kind === "flow") {
      return flowSourcePrompt({
        workspaceName: input.workspaceName,
        sourceId,
        notes: input.notes,
      });
    }
    if (kind === "concept") {
      return conceptSourcePrompt({
        workspaceName: input.workspaceName,
        sourceId,
        notes: input.notes,
      });
    }
  }

  return semanticGlobalPrompt({
    workspaceName: input.workspaceName,
    kind,
    notes: input.notes,
  });
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
    // Branch on source-qualified / cross semantic tasks (PlanScoutTask.sourceId?, cross?).
    const task = input.task as Extract<PlanScoutTask, { kind: SemanticKind }>;
    return semanticSurveyPrompt({
      workspaceName: input.workspaceName,
      kind: semantic,
      notes,
      sourceId: task.sourceId,
      cross: task.cross,
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
