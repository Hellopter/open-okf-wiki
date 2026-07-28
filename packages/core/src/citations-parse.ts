/**
 * Mechanical Source Citation parse + format validation (ADR 0008 page-level grounding).
 * Format from Producer Skill:
 *   single repo:  [Source](repo:path/to/file.py#L10-L20)
 *   multi repo:   [Source](repo:repository-id/path/to/file.py#L10-L20)
 */

/** One parsed Source Citation. */
export type SourceCitation = {
  /** Full match text, e.g. `[Source](repo:foo.ts#L1-L2)`. */
  raw: string;
  /** Path after `repo:` (may include repository-id/ prefix). */
  target: string;
  /** One-based inclusive start line when present. */
  lineStart?: number;
  /** One-based inclusive end line when present. */
  lineEnd?: number;
  /** Character offset in the page body. */
  index: number;
};

/**
 * Match Skill Source Citation links.
 * Line range is optional; when present must be #Lstart or #Lstart-Lend.
 */
export const SOURCE_CITATION_RE = /\[Source\]\(repo:([^)\s#]+)(?:#L(\d+)(?:-L(\d+))?)?\)/g;

/**
 * Parse all Source Citations from Markdown page content.
 */
export function parseSourceCitations(content: string): SourceCitation[] {
  const out: SourceCitation[] = [];
  const re = new RegExp(SOURCE_CITATION_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const target = match[1]!.trim();
    if (!target) {
      continue;
    }
    const lineStart = match[2] ? Number(match[2]) : undefined;
    const lineEnd = match[3] ? Number(match[3]) : undefined;
    out.push({
      raw: match[0],
      target,
      ...(lineStart !== undefined && Number.isFinite(lineStart) ? { lineStart } : {}),
      ...(lineEnd !== undefined && Number.isFinite(lineEnd) ? { lineEnd } : {}),
      index: match.index,
    });
  }
  return out;
}

/**
 * Format-only validation (no filesystem). Returns error strings.
 */
export function validateCitationFormat(citations: SourceCitation[], pageLabel: string): string[] {
  const errors: string[] = [];
  for (const c of citations) {
    if (c.target.includes("..") || c.target.startsWith("/")) {
      errors.push(
        `${pageLabel}: citation path must be repository-relative POSIX (got ${c.target})`,
      );
    }
    if (c.lineStart !== undefined && c.lineStart < 1) {
      errors.push(`${pageLabel}: citation line start must be ≥ 1 (${c.raw})`);
    }
    if (c.lineStart !== undefined && c.lineEnd !== undefined && c.lineEnd < c.lineStart) {
      errors.push(`${pageLabel}: citation line end before start (${c.raw})`);
    }
  }
  return errors;
}
