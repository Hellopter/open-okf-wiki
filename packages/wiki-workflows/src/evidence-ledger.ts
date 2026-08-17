import { MAX_WIKI_RESEARCH_ARTIFACT_BYTES, type WikiArtifactKind, type WikiArtifactRef } from "./artifact-store.js";
import type {
  WikiDelegateContract,
  WikiDelegateRole,
  WikiResearchFollowupDraft,
} from "./delegate-contracts.js";
import { parsePage } from "./frontmatter.js";

export interface EvidenceLedgerCitation {
  scope: string;
  path: string;
  startLine: number;
  endLine: number;
}

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

/** Validate and index one immutable handoff. Prose never crosses this seam. */
export function ingestEvidenceHandoff(input: EvidenceLedgerInput): EvidenceLedgerEntry {
  const role = input.contract.role;
  const expectedKind = artifactKind(role);
  if (input.artifact.kind !== expectedKind) throw new Error(`Evidence handoff kind ${input.artifact.kind} does not match ${role}`);
  if (!input.artifact.runId || !input.artifact.nodeId || input.artifact.attempt < 1) throw new Error("Evidence handoff requires host-owned identity metadata");
  if (Buffer.byteLength(input.markdown, "utf8") > MAX_WIKI_RESEARCH_ARTIFACT_BYTES) throw new Error(`Evidence handoff exceeds the ${MAX_WIKI_RESEARCH_ARTIFACT_BYTES}-byte limit`);
  if (!input.markdown.trim()) throw new Error("Evidence handoff Markdown must not be empty");
  const body = input.markdown.startsWith("---\n") ? parsePage(input.markdown).body : input.markdown;
  const lines = body.split(/\r?\n/);
  const sections = parseSections(lines);
  for (const heading of requiredHeadings(role)) {
    if (!sections.includes(heading.toLowerCase())) throw new Error(`${role} handoff requires a ${heading} heading`);
  }
  const indexes = parseIndexes(lines);
  validateRoleIndexes(role, input.contract, indexes, input.completedAssignmentIds, input.followups);
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

function requiredHeadings(role: WikiDelegateRole): string[] {
  if (role === "research") return ["research handoff", "scope", "coverage", "evidence", "conflicts and alternatives", "gaps and failed reads"];
  if (role === "write") return ["write handoff"];
  return ["review handoff", "findings", "evidence"];
}

function parseSections(lines: string[]): string[] {
  const sections: string[] = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) sections.push(match[2].trim().toLowerCase());
  }
  if (!sections.length || !/^#\s+/.test(lines.find((line) => line.trim()) ?? "")) throw new Error("Evidence handoff requires a level-one role heading");
  return sections;
}

function parseIndexes(lines: string[]): EvidenceLedgerIndexes {
  const assignments: string[] = [];
  const pages: string[] = [];
  const findings: EvidenceLedgerFinding[] = [];
  const citations: EvidenceLedgerCitation[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\bassignment:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g)) assignments.push(match[1]);
    for (const match of line.matchAll(/\bpage:([^\s,;)]+)\b/g)) pages.push(match[1]);
    for (const match of line.matchAll(/\bfinding:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\b/g)) {
      const path = /\bpath:([^\s,;)]+)/.exec(line)?.[1];
      findings.push({ id: match[1], ...(path ? { path } : {}) });
    }
    for (const match of line.matchAll(/repo:([^/\s]+)\/([^#\s]+)#L(\d+)-L(\d+)/g)) {
      const startLine = Number(match[3]);
      const endLine = Number(match[4]);
      if (endLine < startLine) throw new Error("Invalid citation line range");
      citations.push({ scope: match[1], path: match[2], startLine, endLine });
    }
    const citationTokens = [...line.matchAll(/\brepo:[^\s,)]+/g)].map((match) => match[0]);
    if (citationTokens.some((token) => !/^repo:[^/\s]+\/[^#\s]+#L\d+-L\d+$/.test(token))) throw new Error("Evidence handoff citation must use repo:<scope>/<path>#Lx-Ly");
    if (/[A-Za-z0-9._-]+\/[^#\s]+#L\d+-L\d+/.test(line.replace(/\brepo:[^\s,)]+/g, ""))) throw new Error("Evidence handoff citation must use repo:<scope>/<path>#Lx-Ly");
  }
  return {
    assignmentIds: unique(assignments),
    pageIds: unique(pages),
    findings: uniqueFindings(findings),
    citations,
  };
}

function validateRoleIndexes(
  role: WikiDelegateRole,
  contract: WikiDelegateContract,
  indexes: EvidenceLedgerIndexes,
  completed?: readonly string[],
  followups?: readonly WikiResearchFollowupDraft[],
): void {
  if (role !== "write" && indexes.citations.length === 0) throw new Error("Evidence handoff requires at least one source-qualified citation");
  const sourceScopes = new Set(contract.sourceScopeIds);
  if (indexes.citations.some((citation) => !sourceScopes.has(citation.scope))) throw new Error("Evidence handoff citation is outside the pinned source scope");
  if (role === "write") {
    const assigned = new Set(contract.writePaths);
    if (indexes.pageIds.some((page) => !assigned.has(page) && !assigned.has(`wiki/${page}`))) throw new Error("Write handoff contains an unassigned page ID");
    return;
  }
  if (role === "review") {
    const assigned = new Set(contract.reviewPaths);
    if (indexes.findings.some((finding) => finding.path !== undefined && !assigned.has(finding.path))) throw new Error("Review handoff finding is outside the assigned review paths");
    return;
  }
  if (contract.role !== "research") throw new Error("Research handoff requires a research contract");
  const assignments = new Set(contract.assignmentIds);
  if (indexes.assignmentIds.some((id) => !assignments.has(id))) throw new Error("Research handoff contains an undeclared assignment ID");
  if (completed?.some((id) => !assignments.has(id))) throw new Error("Research completion contains an undeclared assignment ID");
  for (const followup of followups ?? []) {
    if (followup.sourceScopeIds.some((scope) => !sourceScopes.has(scope))) throw new Error("Research followup source scope is outside the pinned source scope");
  }
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function uniqueFindings(values: readonly EvidenceLedgerFinding[]): EvidenceLedgerFinding[] {
  const seen = new Set<string>();
  return values.filter((finding) => !seen.has(finding.id) && seen.add(finding.id));
}
