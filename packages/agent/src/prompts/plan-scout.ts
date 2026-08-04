/**
 * Hybrid plan-scout prompts (MoA proposers before Spec synthesizer).
 *
 * Task kinds / selection live in `@okf-wiki/contract/wiki-runs` so workflow
 * freeze materialization does not import agent. This module owns prompt text.
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

export function planScoutPrompt(input: {
  task: PlanScoutTask;
  workspaceName: string;
  operatorNotes?: string;
}): string {
  const notes = input.operatorNotes?.trim()
    ? `Operator focus (respect when relevant):\n${input.operatorNotes.trim()}`
    : "";

  if (input.task.kind === "source") {
    const sid = input.task.sourceId;
    return [
      `You are a plan scout for workspace "${input.workspaceName}".`,
      `Scout focus: SOURCE SURVEY for freeze source "${sid}".`,
      `Inspect only under sources/${sid}/ (README, package manifests, top-level layout, public entrypoints).`,
      "Do not deep-dive other sources in this scout — they have their own surveys.",
      "Use only read tools (ls, find, grep, read). Do not write wiki pages. Do not use bash.",
      notes,
      "",
      "Return a compact structured report with sections:",
      `## Source: ${sid}`,
      "- purpose / role of this repository in one sentence",
      "- entry points (concrete paths under sources/" + sid + "/)",
      "- notable packages or surfaces",
      "- suggested wiki pages that must mention this source",
      "- open questions",
      "",
      "Keep under ~600 words. Prefer paths over prose.",
      `Bind this source later via coverageUnitIds or sourceIds including "${sid}".`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (input.task.kind === "surface") {
    const { sourceId, path: surfacePath, unitId } = input.task;
    const mount =
      surfacePath === "."
        ? `sources/${sourceId}/`
        : `sources/${sourceId}/${surfacePath}/`;
    return [
      `You are a plan scout for workspace "${input.workspaceName}".`,
      `Scout focus: SURFACE SURVEY for unit "${unitId}".`,
      `Inspect primarily under ${mount} (manifests, entrypoints, README if present).`,
      "Use only read tools (ls, find, grep, read). Do not write wiki pages. Do not use bash.",
      notes,
      "",
      "Return a compact structured report with sections:",
      `## Surface: ${unitId}`,
      "- what this package/app/docs root owns",
      "- entry points and public boundaries (paths)",
      "- how it relates to sibling surfaces under the same source",
      "- suggested wiki pages for this surface",
      "- open questions",
      "",
      "Keep under ~500 words. Prefer paths over prose.",
      `Bind this surface later via coverageUnitIds or surfaceIds including "${unitId}".`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const thematic = input.task.thematic;
  const focus = {
    entry: [
      "Scout focus: ENTRY POINTS.",
      "Inspect README, package manifests (package.json, pyproject, go.mod, Cargo.toml, pom.xml),",
      "binaries/CLIs, main modules, and documented quickstarts under sources/.",
      "When multiple sources/ exist, note entry points per source — do not only report the first mount.",
      "List concrete paths a reader should learn first.",
    ].join(" "),
    layout: [
      "Scout focus: REPOSITORY LAYOUT.",
      "Map top-level directories, major packages/apps, and boundaries between them.",
      "For multi-source freezes, map each sources/<id>/; for monorepos, list package surfaces.",
      "Note which areas look independent enough to become Wiki domains.",
    ].join(" "),
    tests: [
      "Scout focus: TESTS & INTENDED BEHAVIOR.",
      "Find test roots and high-signal fixtures that reveal contracts and edge cases.",
      "Do not treat tests as noise — they are evidence of intended behavior.",
    ].join(" "),
    risks: [
      "Scout focus: RISKS & GAPS.",
      "Call out ambiguous ownership, generated code, vendor trees, missing docs,",
      "or areas that would confuse a new reader if omitted from the wiki.",
      "Flag any freeze source or package surface that looks under-surveyed.",
    ].join(" "),
  }[thematic];

  return [
    `You are a plan scout for workspace "${input.workspaceName}".`,
    focus,
    "Use only read tools (ls, find, grep, read). Do not write wiki pages. Do not use bash.",
    notes,
    "",
    "Return a compact structured report (markdown is fine) with sections:",
    "## Findings",
    "- bullet list of concrete repo-relative paths and why they matter",
    "## Suggested domains",
    "- short ids/titles for independent evidence areas (or none)",
    "## Suggested pages",
    "- candidate wiki page paths + one-line purpose (overview.md should appear if entry is clear)",
    "## Open questions",
    "- unknowns the planner must still resolve",
    "",
    "Keep under ~800 words. Prefer paths over prose.",
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
