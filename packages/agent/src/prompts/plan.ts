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
}): string {
  const paths = runWorkdirPromptPaths(input.layout);
  const operatorNotes = input.operatorNotes?.trim();
  return [
    "You are planning a source-grounded repository wiki (WikiRunSpec).",
    paths,
    `Workspace name: ${input.workspaceName}`,
    ...(operatorNotes ? [`Operator-requested focus:\n${operatorNotes}`] : []),
    "Using only read tools (ls, find, grep, read), inspect sources/ entry points",
    "(README, package manifests, top-level layout) and any analysis/plan-scouts/* receipts.",
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
    '  "domains": [{ "id", "title", "scope", "critical", "questions": string[] }],',
    '  "pages": [{ "path", "purpose", "domainIds", "questions", "template"?, "critical" }],',
    '  "openQuestions": string[],',
    '  "acceptance": { "reviewRequired": true, "maxRepairRounds": 2, "blockingSeverities": ["blocking"] },',
    '  "changelog": string[]',
    "}",
    "",
    "Rules:",
    "- Prefer few domains that isolate independent evidence.",
    "- Always include a critical overview.md (or Spec equivalent) with template overview.",
    "- index.md is a listing file generated/written later — do not list it as a concept page.",
    "- Page paths are relative under wiki/, end with .md.",
    "- If plan scout receipts are present, synthesize them into one coherent Spec;",
    "  do not ignore concrete paths they cited without reason.",
    input.wikiLanguage === "zh"
      ? "- Spec summary/purpose/questions may be Chinese; paths stay English filenames."
      : "- Spec prose in English.",
  ].join("\n");
}
