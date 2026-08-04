/**
 * Planner prompt for WikiRunSpec path-first handoff.
 *
 * Doctrine: DiscoveryMap-first + sealed scout files; dual host gates
 * (assertCoverage + assertSemanticSufficiency); chat is never Spec authority.
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
  /** Bundle-relative path to sealed DiscoveryMap when projected. */
  discoveryMapPath?: string;
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

  const discoveryBlock = input.discoveryMapPath
    ? [
        `3. **DiscoveryMap-first:** read \`${input.discoveryMapPath}\` with the read tool before deep source rescans.`,
        "   It is the merged discovery authority (sources, domains, flows, concepts, evidence paths).",
        "4. Read scout receipt files listed in the Plan scout index under inputs/plan-scouts/* (and analysis/plan-scouts/* if needed).",
        "   The index card in this task is paths-only — never invent scout findings from the index alone.",
      ]
    : [
        "3. If `inputs/discovery-map.json` or `analysis/discovery-map.json` exists, read it first (DiscoveryMap authority).",
        "4. Read sealed scout receipts under inputs/plan-scouts/* (index card lists paths; use `read` on each).",
        "   Do not invent findings from the index alone. Prefer file bodies over chat paraphrases.",
      ];

  return [
    "You are planning a source-grounded repository wiki (WikiRunSpec).",
    paths,
    `Workspace name: ${input.workspaceName}`,
    ...(operatorNotes ? [`Operator-requested focus:\n${operatorNotes}`] : []),
    "",
    "## Method (file-first)",
    "1. Read skill/SKILL.md (job index) and skill/references/plan.md in full.",
    "2. File mounts matter: sealed discovery + scouts under inputs/; sources/ is the freeze snapshot.",
    ...discoveryBlock,
    "5. Using only read tools (ls, find, grep, read), fill genuine gaps from sources/",
    "   (implementation entry points, not README-only). Prefer inventory/coverage files as accelerators.",
    "When inputs/prior-spec.json is present (plan revise), read it and revise — do not invent a blank page tree.",
    "Prefer inputs/coverage-inventory.json / coverage-plan.json when present as a scoping accelerator.",
    "Do not write wiki pages. Do not use bash.",
    "",
    "## Handoff (path-first Spec authority)",
    "When ready, call the submit_wiki_run_spec tool with a complete WikiRunSpec",
    "(product validates and writes analysis/plan-draft.json under the Run Boundary).",
    "That tool is the **only** Spec authority for this Attempt.",
    "Do **not** paste the full Spec as chat text as the primary delivery.",
    "Chat/control returns are short ACK only — sealed draft file wins.",
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
    "- If plan scout / DiscoveryMap files are present, synthesize them into one coherent Spec;",
    "  do not ignore concrete paths they cited without reason.",
    "- Dual host gates after submit:",
    "  (1) assertCoverage — required coverage units bound or cancelled on critical pages;",
    "  (2) assertSemanticSufficiency — DiscoveryMap-backed semantic sufficiency (multi-source: every source evidenced or cancelled; cross-source flow or explicit openQuestion).",
    "- Specs that fail either gate are rejected; chat cannot override sealed draft validation.",
    input.wikiLanguage === "zh"
      ? "- Spec summary/purpose/questions may be Chinese; paths stay English filenames."
      : "- Spec prose in English.",
  ].join("\n");
}
