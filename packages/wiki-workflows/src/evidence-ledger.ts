import { MAX_WIKI_RESEARCH_ARTIFACT_BYTES, type WikiArtifactKind, type WikiArtifactRef } from "./artifact-store.js";
import { extractSourceCitations, type SourceCitation } from "./citations.js";
import type {
  WikiDelegateContract,
  WikiDelegateRole,
  WikiResearchFollowupDraft,
} from "./delegate-contracts.js";
import { WikiRejectedError, allowedList, listed } from "./wiki-reject.js";
import { splitWikiWorkFile } from "./wiki-work-files.js";

export type EvidenceLedgerCitation = SourceCitation;

export interface EvidenceLedgerFinding {
  id: string;
  path?: string;
}

export interface EvidenceLedgerIndexes {
  assignmentIds: string[];
  pageIds: string[];
  findings: EvidenceLedgerFinding[];
  citations: EvidenceLedgerCitation[];
}

export interface EvidenceLedgerEntry {
  artifact: WikiArtifactRef;
  role: WikiDelegateRole;
  indexes: EvidenceLedgerIndexes;
  completedAssignmentIds: string[];
  followups: WikiResearchFollowupDraft[];
}

export interface EvidenceLedgerInput {
  artifact: WikiArtifactRef;
  markdown: string;
  contract: WikiDelegateContract;
  completedAssignmentIds?: readonly string[];
  followups?: readonly WikiResearchFollowupDraft[];
}

export interface EvidenceHandoffValidationInput {
  markdown: string;
  contract: WikiDelegateContract;
  completedAssignmentIds?: readonly string[];
  followups?: readonly WikiResearchFollowupDraft[];
  /** Optional line-count lookup for well-formed citations. Undefined skips the file check. */
  fileLines?: (citation: EvidenceLedgerCitation) => number | "missing" | undefined;
}

export interface EvidenceHandoffInspection {
  defects: string[];
  indexes?: EvidenceLedgerIndexes;
}

/** Format checks a leaf can fail in-session. Identity metadata is host-owned. */
export function inspectEvidenceHandoff(input: EvidenceHandoffValidationInput): EvidenceHandoffInspection {
  const role = input.contract.role;
  if (Buffer.byteLength(input.markdown, "utf8") > MAX_WIKI_RESEARCH_ARTIFACT_BYTES) {
    return { defects: [`Evidence handoff exceeds the ${MAX_WIKI_RESEARCH_ARTIFACT_BYTES}-byte limit`] };
  }
  if (!input.markdown.trim()) return { defects: ["Evidence handoff Markdown must not be empty"] };
  const split = splitWikiWorkFile(input.markdown);
  if (split.hasFence && !split.terminated) return { defects: ["handoff must contain terminated YAML frontmatter"] };
  const lines = split.body.split(/\r?\n/);
  const defects: string[] = [];
  const { sections, hasLevelOne } = collectSections(lines);
  if (!hasLevelOne) defects.push("missing level-one role heading");
  const missing = requiredHeadings(role).filter((heading) => !sections.includes(heading.slug));
  if (missing.length) defects.push(`missing headings: ${listed(missing.map((heading) => heading.display))}`);
  const parsed = collectIndexes(lines, input.fileLines);
  defects.push(...parsed.defects);
  defects.push(...collectRoleIndexDefects(role, input.contract, parsed.indexes));
  if (defects.length) return { defects };
  return { defects: [], indexes: parsed.indexes };
}

export function validateEvidenceHandoff(input: EvidenceHandoffValidationInput): EvidenceLedgerIndexes {
  const inspected = inspectEvidenceHandoff(input);
  if (inspected.defects.length) throw new WikiRejectedError(inspected.defects);
  return inspected.indexes!;
}

/** Validate and index one immutable handoff. Prose never crosses this seam. */
export function ingestEvidenceHandoff(input: EvidenceLedgerInput): EvidenceLedgerEntry {
  const role = input.contract.role;
  const expectedKind = artifactKind(role);
  if (input.artifact.kind !== expectedKind) throw new Error(`Evidence handoff kind ${input.artifact.kind} does not match ${role}`);
  if (!input.artifact.runId || !input.artifact.nodeId || input.artifact.attempt < 1) throw new Error("Evidence handoff requires host-owned identity metadata");
  const indexes = validateEvidenceHandoff(input);
  const hostDefects = collectHostOwnedIndexDefects(role, input.contract, input.completedAssignmentIds, input.followups);
  if (hostDefects.length) throw new WikiRejectedError(hostDefects);
  return {
    artifact: structuredClone(input.artifact),
    role,
    indexes,
    completedAssignmentIds: [...(input.completedAssignmentIds ?? [])],
    followups: structuredClone([...(input.followups ?? [])]),
  };
}

function artifactKind(role: WikiDelegateRole): WikiArtifactKind {
  return role === "research" ? "research-handoff" : role === "write" ? "write-handoff" : "review-handoff";
}

function requiredHeadings(role: WikiDelegateRole): Array<{ slug: string; display: string }> {
  if (role === "research") {
    return [
      { slug: "research handoff", display: "Research Handoff" },
      { slug: "scope", display: "Scope" },
      { slug: "coverage", display: "Coverage" },
      { slug: "evidence", display: "Evidence" },
      { slug: "conflicts and alternatives", display: "Conflicts and alternatives" },
      { slug: "gaps and failed reads", display: "Gaps and failed reads" },
    ];
  }
  if (role === "write") return [{ slug: "write handoff", display: "Write Handoff" }];
  return [
    { slug: "review handoff", display: "Review Handoff" },
    { slug: "findings", display: "Findings" },
    { slug: "evidence", display: "Evidence" },
  ];
}

function collectSections(lines: string[]): { sections: string[]; hasLevelOne: boolean } {
  const sections: string[] = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) sections.push(match[2].trim().toLowerCase());
  }
  const first = lines.find((line) => line.trim()) ?? "";
  return { sections, hasLevelOne: /^#\s+/.test(first) };
}

function collectIndexes(
  lines: string[],
  fileLines?: (citation: EvidenceLedgerCitation) => number | "missing" | undefined,
): { indexes: EvidenceLedgerIndexes; defects: string[] } {
  const assignments: string[] = [];
  const pages: string[] = [];
  const findings: EvidenceLedgerFinding[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\bassignment:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g)) assignments.push(match[1]);
    for (const match of line.matchAll(/\bpage:([^\s,;)]+)\b/g)) pages.push(match[1]);
    for (const match of line.matchAll(/\bfinding:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g)) {
      const path = /\bpath:([^\s,;)]+)/.exec(line)?.[1];
      findings.push({ id: match[1], ...(path ? { path } : {}) });
    }
  }
  const extracted = extractSourceCitations(lines.join("\n"), fileLines);
  return {
    indexes: {
      assignmentIds: unique(assignments),
      pageIds: unique(pages),
      findings: uniqueFindings(findings),
      citations: extracted.citations,
    },
    defects: extracted.invalid.length ? [`invalid citations: ${listed(extracted.invalid)}`] : [],
  };
}

function collectRoleIndexDefects(
  role: WikiDelegateRole,
  contract: WikiDelegateContract,
  indexes: EvidenceLedgerIndexes,
): string[] {
  const defects: string[] = [];
  if (role !== "write" && indexes.citations.length === 0) {
    defects.push(`${role} handoff requires at least one source-qualified citation`);
  }
  const sourceScopes = contract.sourceScopeIds;
  const outside = unique(indexes.citations.map((citation) => citation.scope).filter((scope) => !sourceScopes.includes(scope)));
  if (outside.length) {
    defects.push(`citation scopes outside pinned scopes: ${listed(outside)} (allowed: ${allowedList(sourceScopes)})`);
  }
  if (role === "write") {
    const assigned = contract.writePaths ?? [];
    const assignedSet = new Set(assigned);
    const unassigned = indexes.pageIds.filter((page) => !assignedSet.has(page) && !assignedSet.has(`wiki/${page}`));
    if (unassigned.length) {
      defects.push(`unassigned page IDs: ${listed(unassigned)} (assigned: ${allowedList(assigned)})`);
    }
    return defects;
  }
  if (role === "review") {
    const assigned = contract.reviewPaths ?? [];
    const assignedSet = new Set(assigned);
    const outsidePaths = unique(
      indexes.findings.flatMap((finding) => finding.path !== undefined && !assignedSet.has(finding.path) ? [finding.path] : []),
    );
    if (outsidePaths.length) {
      defects.push(`review finding paths outside assigned paths: ${listed(outsidePaths)} (assigned: ${allowedList(assigned)})`);
    }
    return defects;
  }
  if (contract.role !== "research") throw new Error("Research handoff requires a research contract");
  const declared = contract.assignmentIds;
  const undeclared = indexes.assignmentIds.filter((id) => !declared.includes(id));
  if (undeclared.length) {
    defects.push(`undeclared assignment IDs: ${listed(undeclared)} (declared: ${allowedList(declared)})`);
  }
  return defects;
}

function collectHostOwnedIndexDefects(
  role: WikiDelegateRole,
  contract: WikiDelegateContract,
  completed?: readonly string[],
  followups?: readonly WikiResearchFollowupDraft[],
): string[] {
  if (role !== "research" || contract.role !== "research") return [];
  const defects: string[] = [];
  const declared = contract.assignmentIds;
  const undeclared = (completed ?? []).filter((id) => !declared.includes(id));
  if (undeclared.length) {
    defects.push(`undeclared assignment IDs: ${listed(undeclared)} (declared: ${allowedList(declared)})`);
  }
  const sourceScopes = contract.sourceScopeIds;
  const outside = unique((followups ?? []).flatMap((followup) => followup.sourceScopeIds.filter((scope) => !sourceScopes.includes(scope))));
  if (outside.length) {
    defects.push(`followup scopes outside pinned scopes: ${listed(outside)} (allowed: ${allowedList(sourceScopes)})`);
  }
  return defects;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function uniqueFindings(values: readonly EvidenceLedgerFinding[]): EvidenceLedgerFinding[] {
  const seen = new Set<string>();
  return values.filter((finding) => !seen.has(finding.id) && seen.add(finding.id));
}
