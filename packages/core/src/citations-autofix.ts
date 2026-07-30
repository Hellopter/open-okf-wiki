/**
 * Mechanical Source Citation auto-fix (off-by-one line clamps + wiki-tree rewrite).
 * Prefer running before hard validate so small LLM line-range errors do not fail the run.
 */

import { readFile, writeFile } from "node:fs/promises";
import {
  type CanonicalizeCitationOptions,
  canonicalizeCitationTarget,
  countFileLines,
  formatRepoCitation,
  resolveCitationFile,
  type SourceRootMap,
} from "./citations-canonicalize.js";
import { parseSourceCitations } from "./citations-parse.js";
import { scanWikiTree } from "./wiki-tree.js";

export type ClampCitationOptions = {
  /** Max lines end/start may exceed file length and still be clamped (default 1). */
  lineSlack?: number;
};

/** Aligns with EvaluationPolicy.mechanical.autoFix.clampLineSlack default. */
const DEFAULT_LINE_SLACK = 1;

/**
 * If lineStart/lineEnd exceed lineCount by at most slack, clamp to lineCount.
 * Returns adjusted fields; `clamped` is true only when values changed.
 *
 * Not clampable cases (start < 1, or overflow beyond slack) leave inputs
 * unchanged with `clamped: false` so hard validate can still fail.
 */
export function clampCitationLineRange(
  lineStart: number | undefined,
  lineEnd: number | undefined,
  lineCount: number,
  slack: number = DEFAULT_LINE_SLACK,
): { lineStart?: number; lineEnd?: number; clamped: boolean } {
  if (lineStart === undefined) {
    return { lineStart, lineEnd, clamped: false };
  }

  // start < 1 is a hard format/range error — do not auto-fix.
  if (lineStart < 1) {
    return { lineStart, lineEnd, clamped: false };
  }

  const maxSlack = Math.max(0, slack);
  let start = lineStart;
  let end = lineEnd;
  let clamped = false;

  if (start > lineCount) {
    if (start - lineCount > maxSlack) {
      return { lineStart, lineEnd, clamped: false };
    }
    start = lineCount;
    end = lineCount;
    clamped = true;
  } else if (end !== undefined && end > lineCount) {
    if (end - lineCount > maxSlack) {
      return { lineStart, lineEnd, clamped: false };
    }
    end = lineCount;
    clamped = true;
  }

  // After clamp, keep a valid inclusive range.
  if (end !== undefined && end < start) {
    end = start;
    clamped = true;
  }

  // Drop redundant end === start so formatRepoCitation emits #Lstart only.
  // Keep caller's end presence when unchanged and equal (format collapses it).
  return {
    lineStart: start,
    ...(end !== undefined ? { lineEnd: end } : {}),
    clamped,
  };
}

export type AutofixCitationsInContentOptions = CanonicalizeCitationOptions & {
  /**
   * Resolve a (canonical) citation target to its source file line count.
   * Return null to skip line clamping for that citation.
   */
  getLineCount: (target: string) => Promise<number | null>;
  lineSlack?: number;
};

export type AutofixCitationsInContentResult = {
  content: string;
  changed: boolean;
  fixes: string[];
};

/**
 * Parse citations, canonicalize targets, and clamp off-by-one line ranges.
 * Rewrites with {@link formatRepoCitation}. Processes matches end→start.
 */
export async function autofixCitationsInContent(
  content: string,
  options: AutofixCitationsInContentOptions,
): Promise<AutofixCitationsInContentResult> {
  const citations = parseSourceCitations(content);
  if (citations.length === 0) {
    return { content, changed: false, fixes: [] };
  }

  const ordered = [...citations].sort((a, b) => b.index - a.index);
  let out = content;
  let changed = false;
  const fixes: string[] = [];
  const slack = options.lineSlack ?? DEFAULT_LINE_SLACK;

  for (const c of ordered) {
    const canon = canonicalizeCitationTarget(c.target, {
      sourceIds: options.sourceIds,
      multiSource: options.multiSource,
    });
    if (!canon.ok) {
      continue;
    }

    let nextStart = c.lineStart;
    let nextEnd = c.lineEnd;
    let lineClamped = false;

    if (c.lineStart !== undefined) {
      const lineCount = await options.getLineCount(canon.target);
      if (lineCount !== null) {
        const clamped = clampCitationLineRange(c.lineStart, c.lineEnd, lineCount, slack);
        if (clamped.clamped) {
          nextStart = clamped.lineStart;
          nextEnd = clamped.lineEnd;
          lineClamped = true;
          fixes.push(
            `clamped ${c.raw} → ${formatRepoCitation(canon.target, nextStart, nextEnd)} ` +
              `(file has ${lineCount} lines)`,
          );
        }
      }
    }

    const targetChanged = canon.target !== c.target;
    if (!targetChanged && !lineClamped) {
      continue;
    }

    if (targetChanged) {
      fixes.push(`canonicalized ${c.raw} → target ${canon.target}`);
    }

    const next = formatRepoCitation(canon.target, nextStart, nextEnd);
    out = out.slice(0, c.index) + next + out.slice(c.index + c.raw.length);
    changed = true;
  }

  return { content: out, changed, fixes };
}

export type AutofixWikiTreeResult = {
  rewrittenPages: number;
  fixes: string[];
  errors: string[];
};

/**
 * Scan a staging wiki tree and mechanically fix citation targets + off-by-one lines.
 * Uses {@link resolveCitationFile} against pinned Snapshot roots for line counts.
 */
export async function autofixWikiTreeCitations(
  wikiRoot: string,
  sources: SourceRootMap,
  opts?: { lineSlack?: number },
): Promise<AutofixWikiTreeResult> {
  const sourceIds =
    sources.roots.size > 0
      ? [...sources.roots.keys()]
      : sources.singleRoot
        ? [sources.singleRoot.id]
        : [];
  const multiSource = sources.roots.size > 1;
  const slack = opts?.lineSlack ?? DEFAULT_LINE_SLACK;

  const scan = await scanWikiTree(wikiRoot);
  let rewrittenPages = 0;
  const fixes: string[] = [];
  const errors: string[] = [];

  for (const file of scan.files) {
    if (!file.relativePath.toLowerCase().endsWith(".md")) {
      continue;
    }
    let raw: string;
    try {
      raw = await readFile(file.absolutePath, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${file.relativePath}: cannot read page: ${message}`);
      continue;
    }

    const result = await autofixCitationsInContent(raw, {
      sourceIds,
      multiSource,
      lineSlack: slack,
      getLineCount: async (target) => {
        // Build a synthetic citation so resolveCitationFile can map the target.
        const synthetic = {
          raw: `[Source](repo:${target})`,
          target,
          index: 0,
        };
        const resolved = resolveCitationFile(synthetic, sources);
        if (resolved === null || "error" in resolved) {
          return null;
        }
        try {
          return await countFileLines(resolved.absPath);
        } catch {
          return null;
        }
      },
    });

    for (const f of result.fixes) {
      fixes.push(`${file.relativePath}: ${f}`);
    }
    if (result.changed) {
      try {
        await writeFile(file.absolutePath, result.content, "utf8");
        rewrittenPages += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file.relativePath}: cannot write page: ${message}`);
      }
    }
  }

  return { rewrittenPages, fixes, errors };
}
