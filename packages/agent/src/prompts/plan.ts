/**
 * Planner prompt for WikiRunSpec path-first handoff.
 */

import type { RunWorkdirLayout } from "../runtime/workdir.js";
import { runWorkdirPromptPaths } from "../runtime/workdir.js";
import type { WikiLanguage } from "./system.js";

export function plannerPrompt(input: {
  layout: RunWorkdirLayout;
  workspaceName: string;
  wikiLanguage?: WikiLanguage;
  operatorNotes?: string;
  /** Topology caps — when set, listed in Rules so the planner stays under budget. */
  maxDomainFanOut?: number;
  maxLeafFanOut?: number;
  /** Freeze source count (multi-source rules when >= 2). */
  sourceCount?: number;
  /** Required coverage unit ids from host plan (when non-empty). */
  requiredUnitIds?: readonly string[];
}): string {
  const paths = runWorkdirPromptPaths(input.layout);
  const operatorNotes = input.operatorNotes?.trim();
  const fanOutRules: string[] = [];
  if (input.maxDomainFanOut != null) {
    fanOutRules.push(
      `- At most ${input.maxDomainFanOut} domain(s) (workspace.orchestration.maxDomainFanOut). ` +
        "Merge related concerns rather than exceeding the cap; over-cap Specs are rejected.",
    );
  }
  if (input.maxLeafFanOut != null) {
    fanOutRules.push(
      `- At most ${input.maxLeafFanOut} question(s) per domain (workspace.orchestration.maxLeafFanOut). ` +
        "Split into fewer, broader questions if needed; over-cap Specs are rejected.",
    );
  }

  const multiSource = (input.sourceCount ?? input.layout.sourceMounts.size) >= 2;
  const multiSourceRules = multiSource
    ? [
        "- Multi-source freeze: survey every sources/<id>/ before synthesizing; do not let the first mount dominate.",
        "- Bind every freeze source on at least one critical page via coverageUnitIds or sourceIds,",
        "  or cancel via sourceCoverage: { sourceId, cancelled: true, notes: \"reason\" }",
        "  (notes/changelog alone do not cancel — host only honors sourceCoverage/surfaceCoverage.cancelled).",
        "- Prefer an overview repository map and at least one cross-source flow/architecture page when sources integrate.",
        "- Citations later use repo:<id>/path; Spec coverage bindings use bare sourceId unit ids.",
      ]
    : [];

  const surfaceRules = [
    "- Large single-repo / monorepo: treat distinct packages/apps (surfaces) as coverage units when the host inventory lists them.",
    "- Surface unit ids are source-qualified: {sourceId}::{path} (path may be . for the source root).",
    "- Bind required surfaces via coverageUnitIds or surfaceIds on critical pages,",
    "  or cancel via surfaceCoverage: { surfaceId, cancelled: true, notes: \"reason\" }.",
  ];

  const requiredBlock =
    input.requiredUnitIds && input.requiredUnitIds.length > 0
      ? [
          "",
          "Host required coverage units (must bind or cancel):",
          ...input.requiredUnitIds.map((id) => `- ${id}`),
        ]
      : [];

  return [
    "You are planning a source-grounded repository wiki (WikiRunSpec).",
    paths,
    `Workspace name: ${input.workspaceName}`,
    ...(operatorNotes ? [`Operator-requested focus:\n${operatorNotes}`] : []),
    "1. Read skill/SKILL.md (job index) and skill/references/plan.md in full.",
    "2. Using only read tools (ls, find, grep, read), inspect sources/ entry points",
    "(README, package manifests, top-level layout) and any inputs/plan-scouts/* receipts",
    "(sealed durable plan.scout outputs; also check analysis/plan-scouts/* if present).",
    "When inputs/prior-spec.json is present (plan revise), read it and revise — do not invent a blank page tree.",
    "Prefer inputs/coverage-inventory.json / coverage-plan.json when present as a scoping accelerator.",
    "Do not write wiki pages. Do not use bash.",
    "",
    "When ready, call the submit_wiki_run_spec tool with a complete WikiRunSpec",
    "(product validates and writes analysis/plan-draft.json under the Run Boundary). That tool is the handoff —",
    "do not paste the full Spec as chat text as the primary delivery.",
    "",
    "WikiRunSpec fields:",
    "{",
    '  "version": 1,',
    '  "summary": string,',
    '  "audience": string,',
    '  "domains": [{ "id", "title", "scope", "critical", "questions": string[], "coverageUnitIds"?, "sourceIds"? }],',
    '  "pages": [{ "path", "purpose", "domainIds", "questions", "template"?, "critical", "coverageUnitIds"?, "sourceIds"?, "surfaceIds"? }],',
    '  "openQuestions": string[],',
    '  "repositoryMap"?: { "summary"?, "sources"?: [{ "sourceId", "role"?, "entryPoints"? }] },',
    '  "sourceCoverage"?: [{ "sourceId", "pagePaths"?, "notes"?, "cancelled"? }],',
    '  "surfaceCoverage"?: [{ "surfaceId", "pagePaths"?, "notes"?, "cancelled"? }],',
    '  "acceptance": { "reviewRequired": true, "maxRepairRounds": 2, "maxHardValidateRepairRounds": 0, "blockingSeverities": ["blocking"] },',
    '  "changelog": string[]',
    "}",
    "",
    "Rules:",
    "- Prefer few domains that isolate independent evidence.",
    ...fanOutRules,
    ...multiSourceRules,
    ...surfaceRules,
    ...requiredBlock,
    "- Always include a critical overview.md (or Spec equivalent) with template overview.",
    "- Prefer directory paths when multiple related pages share a theme: modules/*.md, flows/*.md, deeper as needed.",
    "- index.md is not a concept page and is not written by the planner. The product regenerates every directory's index.md mechanically as a progressive-disclosure listing.",
    "- Spec pages MUST NOT include index.md or log.md.",
    "- Page paths are relative under wiki/, end with .md, and name concept pages only.",
    "- If plan scout receipts are present, synthesize them into one coherent Spec;",
    "  do not ignore concrete paths they cited without reason.",
    "- Host assertCoverage rejects Specs that omit required coverage units on critical pages.",
    input.wikiLanguage === "zh"
      ? "- Spec summary/purpose/questions may be Chinese; paths stay English filenames."
      : "- Spec prose in English.",
  ].join("\n");
}
