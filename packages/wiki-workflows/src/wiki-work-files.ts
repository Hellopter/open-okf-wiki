import YAML from "yaml";
import {
  WIKI_FOLLOWUP_KINDS,
  parseWikiResearchSignal,
  parseWikiReviewResult,
  truncateUtf8,
  type WikiFollowupKind,
  type WikiResearchSignal,
  type WikiReviewResult,
} from "./delegate-contracts.js";

export const MAX_WIKI_WORK_FILE_BYTES = 256 * 1024;

type MarkdownInput = string | Uint8Array;

export function decodeUtf8Fatal(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Malformed UTF-8 input", { cause: error });
  }
}

export function parseResearchHandoff(
  markdown: MarkdownInput,
  status: "complete" | "incomplete",
  allowedSourceScopes: readonly string[],
): WikiResearchSignal {
  const { frontmatter, body } = parseHandoff(markdown, "handoff.md");
  exactKeys(frontmatter, ["followups"], "handoff.md frontmatter");
  const scopes = uniqueStrings(allowedSourceScopes, "handoff.md allowedSourceScopes");
  if (!Array.isArray(frontmatter.followups)) {
    throw new Error("handoff.md frontmatter.followups must be an array");
  }
  const followups = frontmatter.followups.map((value, index) => {
    const field = `handoff.md frontmatter.followups[${index}]`;
    const item = record(value, field);
    exactKeys(item, ["kind", "question"], field);
    if (!(WIKI_FOLLOWUP_KINDS as readonly unknown[]).includes(item.kind)) {
      throw new Error(`${field}.kind must be a supported followup kind`);
    }
    const question = truncateUtf8(nonEmptyString(item.question, `${field}.question`), 512);
    return {
      kind: item.kind as WikiFollowupKind,
      question,
      sourceScopeIds: [...scopes],
    };
  });
  const summary = summarizeWikiMarkdown(body, "handoff.md body");
  return parseWikiResearchSignal({
    status,
    summary,
    needsFollowup: followups.length > 0,
    followups,
  });
}

export function parseReviewHandoff(
  markdown: MarkdownInput,
  verdict: "pass" | "changes_requested",
  assignedPaths: readonly string[],
): WikiReviewResult {
  const { frontmatter, body } = parseHandoff(markdown, "review.md");
  exactKeys(frontmatter, ["findings", "profileCoverage"], "review.md frontmatter");
  const reviewedPaths = nonEmptyUniqueStrings(assignedPaths, "review.md assignedPaths");
  const assigned = new Set(reviewedPaths);
  if (!Array.isArray(frontmatter.findings)) {
    throw new Error("review.md frontmatter.findings must be an array");
  }
  const findings = frontmatter.findings.map((value, index) => {
    const field = `review.md frontmatter.findings[${index}]`;
    const item = record(value, field);
    exactKeys(item, ["path", "severity"], field);
    const path = nonEmptyString(item.path, `${field}.path`);
    if (!assigned.has(path)) throw new Error(`${field}.path is outside assigned paths: ${path}`);
    if (item.severity !== "critical" && item.severity !== "major" && item.severity !== "minor") {
      throw new Error(`${field}.severity must be critical, major, or minor`);
    }
    return { id: `finding-${index + 1}`, path, severity: item.severity };
  });
  const profileCoverage = stringArray(frontmatter.profileCoverage, "review.md frontmatter.profileCoverage");
  return parseWikiReviewResult({ verdict, reviewedPaths, findings, profileCoverage });
}

function parseHandoff(markdown: MarkdownInput, file: "handoff.md" | "review.md"): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const bytes = typeof markdown === "string" ? Buffer.byteLength(markdown, "utf8") : markdown.byteLength;
  if (bytes > MAX_WIKI_WORK_FILE_BYTES) throw new Error(`${file} exceeds 256 KiB`);
  const text = typeof markdown === "string" ? markdown : decodeUtf8Fatal(markdown);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error(`${file} must contain terminated YAML frontmatter`);
  let frontmatter: unknown;
  try {
    frontmatter = YAML.parse(match[1]);
  } catch (error) {
    throw new Error(`Invalid ${file} YAML frontmatter: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = record(frontmatter, `${file} frontmatter`);
  const body = text.slice(match[0].length);
  if (!body.trim()) throw new Error(`${file} body must be nonempty`);
  return { frontmatter: parsed, body };
}

export function summarizeWikiMarkdown(markdown: string, field: string): string {
  return truncateUtf8(firstSubstantiveParagraph(markdown, field), 1024);
}

function firstSubstantiveParagraph(body: string, field: string): string {
  const paragraph: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    if (/^#{1,6}(?:\s|$)|^(?:```|~~~)|^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    const listItem = /^(?:[-+*]|\d+[.)])\s+/.test(line);
    const prose = line
      .replace(/^>\s*/, "")
      .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
      .trim();
    const structuralLabel = /^(?:\*\*[^*]+[:：]?\*\*|__[^_]+[:：]?__|[\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}[:：])(?:\s+.*)?$/u;
    if (!prose || structuralLabel.test(prose) && (listItem || /^\S[^.!?。！？]*[:：]$/.test(prose))) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    paragraph.push(prose);
  }
  if (paragraph.length) return paragraph.join(" ");
  throw new Error(`${field} must contain substantive prose`);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${field} has unknown field: ${unknown[0]}`);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${field}.${missing[0]} is required`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a mapping`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of nonempty strings`);
  }
  return value.map((item) => String(item).trim());
}

function nonEmptyUniqueStrings(value: readonly string[], field: string): string[] {
  const parsed = uniqueStrings(value, field);
  if (!parsed.length) throw new Error(`${field} must not be empty`);
  return parsed;
}

function uniqueStrings(value: readonly string[], field: string): string[] {
  const parsed = stringArray(value, field);
  if (new Set(parsed).size !== parsed.length) throw new Error(`${field} must contain unique values`);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
