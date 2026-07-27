/**
 * Shared prompt helpers (language, page/domain lists, template types).
 */

import type { WikiLanguage, WikiRunSpec } from "@okf-wiki/contract";

export type { WikiLanguage };

export function pageList(spec: WikiRunSpec): string {
  const pages = spec.pages ?? [];
  if (pages.length === 0) {
    return "- overview.md (critical) — repository overview";
  }
  return pages
    .map((p) => {
      const crit = p.critical === false ? "optional" : "critical";
      const tpl = p.template ? ` template=${p.template}` : "";
      return `- ${p.path} (${crit}${tpl}) — ${p.purpose}`;
    })
    .join("\n");
}

export function domainList(spec: WikiRunSpec): string {
  const domains = spec.domains ?? [];
  if (domains.length === 0) return "(no domains listed)";
  return domains
    .map(
      (d) =>
        `- ${d.id}: ${d.title} — scope: ${d.scope}` +
        (d.questions?.length ? `\n  questions: ${d.questions.join("; ")}` : ""),
    )
    .join("\n");
}

/** Type values aligned with skill templates + OKF. */
export function typeForTemplate(template?: string, path?: string): string {
  if (template === "overview" || path === "overview.md") return "Overview";
  if (template === "architecture") return "Architecture";
  if (template === "module") return "Module";
  if (template === "flow") return "Flow";
  if (template === "concept") return "Concept";
  if (path?.endsWith("architecture.md")) return "Architecture";
  return "Concept";
}
