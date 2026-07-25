/**
 * Root writer prompts for Staging Wiki pages.
 */

import type { WikiRunSpec } from "@okf-wiki/contract";
import type { RunWorkdirLayout } from "../runtime/run-workdir.js";
import { runWorkdirPromptPaths } from "../runtime/run-workdir.js";
import { domainList, pageList, type WikiLanguage } from "./system.js";

/**
 * Root writer live user prompt — must drive full Spec pages, not a stub index.
 */
export function rootWritePrompt(input: {
  layout: RunWorkdirLayout;
  spec: WikiRunSpec;
  wikiLanguage?: WikiLanguage;
  multiSource?: boolean;
  receiptIndex?: string;
  repairDefects?: string;
  isRefresh?: boolean;
}): string {
  const paths = runWorkdirPromptPaths(input.layout);
  const lang =
    input.wikiLanguage === "zh"
      ? "Write page titles and body prose in Simplified Chinese. Keep paths, identifiers, and Source Citations untranslated."
      : "Write page titles and body prose in English.";
  const citeForm = input.multiSource
    ? "For multiple repositories: [Source](repo:repository-id/path/to/file#L10-L20)."
    : "For a single repository: [Source](repo:path/to/file#L10-L20).";
  const branch = input.isRefresh
    ? "Read skill/references/refresh.md in full (wiki/ already has prior pages)."
    : "Read skill/references/generate.md in full (wiki/ starts empty or fixture-seeded).";
  const receipts =
    input.receiptIndex?.trim() ||
    "List analysis/ for receipt JSON files; re-open load-bearing source spans as needed.";
  const repair = input.repairDefects?.trim()
    ? [
        "",
        "## Repair mode",
        "Blocking defects from the review council (fix these issues; do not rewrite unrelated pages unless needed):",
        input.repairDefects.trim(),
      ].join("\n")
    : "";

  return [
    "You are the Open OKF Wiki Root writer.",
    paths,
    "",
    "## Method",
    "1. Read skill/SKILL.md in full.",
    `2. ${branch}`,
    "3. Read analysis/spec.json (living WikiRunSpec) and follow its pages/domains.",
    "4. Read relevant skill/templates/{overview,architecture,module,flow,concept}.md before writing those page kinds.",
    "5. Use only tools: ls, find, grep, read, write, edit. Never use bash.",
    "",
    "## Language",
    lang,
    "",
    "## Spec pages (write every critical path under wiki/)",
    pageList(input.spec),
    "",
    "## Domains (context)",
    domainList(input.spec),
    "",
    "## Evidence receipts",
    receipts,
    "",
    "## Output contract (OKF + product)",
    "- Concept pages (all .md except index.md / log.md): YAML frontmatter with non-empty `type` and `title`.",
    "  Suggested types: Overview, Architecture, Module, Flow, Concept.",
    "- wiki/index.md is a reserved listing only (OKF §6): bullet links to concept pages; NO concept frontmatter; NO Source Citations required.",
    "- Do not put the narrative overview only in index.md — use overview.md (or Spec path) for prose.",
    `- Place verified Source Citations beside facts. ${citeForm}`,
    "- Line numbers must come from read/grep results — never invent ranges.",
    "- Internal links: relative paths ending in .md.",
    "- Cross-link related pages.",
    "",
    "When finished, ensure every critical Spec page exists on disk under wiki/.",
    repair,
  ].join("\n");
}

export function rootWriteSystemPrompt(): string {
  return [
    "You are the Open OKF Wiki producer agent (Root writer).",
    "Use only the provided tools. Never use bash.",
    "Read skill/SKILL.md before writing. Follow analysis/spec.json.",
    "Write Staging Wiki pages under wiki/. Prefer Spec page paths.",
    "Concept pages need type + title frontmatter; index.md is listing-only.",
    "Cite sources with [Source](repo:…) form from real tool line numbers.",
  ].join(" ");
}
