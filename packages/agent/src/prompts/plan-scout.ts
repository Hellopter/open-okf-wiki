/**
 * Orthogonal plan-scout prompts (MoA proposers before Spec synthesizer).
 */

export type PlanScoutKind = "entry" | "layout" | "tests" | "risks";

export const PLAN_SCOUT_KINDS: readonly PlanScoutKind[] = [
  "entry",
  "layout",
  "tests",
  "risks",
] as const;

export function planScoutPrompt(input: {
  kind: PlanScoutKind;
  workspaceName: string;
  operatorNotes?: string;
}): string {
  const focus = {
    entry: [
      "Scout focus: ENTRY POINTS.",
      "Inspect README, package manifests (package.json, pyproject, go.mod, Cargo.toml, pom.xml),",
      "binaries/CLIs, main modules, and documented quickstarts under sources/.",
      "List concrete paths a reader should learn first.",
    ].join(" "),
    layout: [
      "Scout focus: REPOSITORY LAYOUT.",
      "Map top-level directories, major packages/apps, and boundaries between them.",
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
    ].join(" "),
  }[input.kind];

  const notes = input.operatorNotes?.trim()
    ? `Operator focus (respect when relevant):\n${input.operatorNotes.trim()}`
    : "";

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
