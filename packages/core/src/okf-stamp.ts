/**
 * Deterministic OKF v0.2 provenance stamping for publish candidates.
 *
 * The Run Boundary — not the model — owns `generated`, `verified`, and
 * `okf_version` (SPEC §5.2/§12): timestamps and verification are mechanical
 * facts of the Wiki Run, so the writer prompt forbids the model from
 * authoring them and publish stamps them here on the candidate tree only.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isReservedWikiPath, scanWikiTree } from "./wiki-tree.js";

export const OKF_VERSION = "0.2";

export type OkfVerification = {
  /** Actor per OKF §7, e.g. `process:review-council`. */
  by: string;
  /** ISO 8601 datetime. */
  at: string;
};

export type OkfStamp = {
  /** Actor that produced page content, e.g. `okf-wiki/<modelId>` (OKF §7). */
  generatedBy: string;
  /** ISO 8601 datetime of the content's last meaningful change (publish time). */
  generatedAt: string;
  /** Verification events (e.g. clean review council) — omitted ⇒ unverified tier. */
  verified?: OkfVerification[];
  /** Bundle spec version for the root index.md; defaults to {@link OKF_VERSION}. */
  okfVersion?: string;
};

export type OkfStampTreeResult = {
  /** Concept pages that received a `generated` and/or `verified` stamp. */
  stampedPages: number;
  /** True when the root index.md received (or already had) `okf_version`. */
  rootIndexStamped: boolean;
};

/** Double-quoted YAML scalar, safe for actors/timestamps in flow mappings. */
function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function verificationYaml(verified: OkfVerification[]): string {
  if (verified.length === 1) {
    const only = verified[0]!;
    return `verified: { by: ${yamlQuote(only.by)}, at: ${yamlQuote(only.at)} }`;
  }
  const entries = verified.map((v) => `  - { by: ${yamlQuote(v.by)}, at: ${yamlQuote(v.at)} }`);
  return ["verified:", ...entries].join("\n");
}

type FrontmatterSplit = {
  /** Frontmatter inner lines (no delimiters), original line endings dropped. */
  inner: string;
  /** Body after the closing delimiter line (leading newline preserved). */
  rest: string;
  /** BOM prefix when present, re-emitted verbatim. */
  bom: string;
};

/** UTF-8 BOM, kept out of string literals so the file has no invisible chars. */
const BOM = String.fromCharCode(0xfeff);

function splitFrontmatter(content: string): FrontmatterSplit | null {
  const bom = content.startsWith(BOM) ? BOM : "";
  const withoutBom = bom ? content.slice(1) : content;
  const firstNewline = withoutBom.indexOf("\n");
  if (firstNewline < 0 || withoutBom.slice(0, firstNewline).trim() !== "---") {
    return null;
  }
  const rest = withoutBom.slice(firstNewline + 1);
  const closeMatch = /^---[ \t]*$/m.exec(rest);
  if (!closeMatch) {
    return null;
  }
  const inner = rest.slice(0, closeMatch.index).replace(/\n$/, "");
  return { inner, rest: rest.slice(closeMatch.index + closeMatch[0].length), bom };
}

function hasTopLevelKey(frontmatterInner: string, key: string): boolean {
  const re = new RegExp(`^${key}\\s*:`, "m");
  return re.test(frontmatterInner);
}

/**
 * Stamp one concept page's frontmatter with `generated` (and `verified`).
 * Pages without parseable frontmatter, or that already carry the key, are
 * left byte-identical. Returns the (possibly unchanged) content.
 */
export function stampConceptPage(content: string, stamp: OkfStamp): string {
  const split = splitFrontmatter(content);
  if (!split) return content;

  const additions: string[] = [];
  if (!hasTopLevelKey(split.inner, "generated")) {
    additions.push(
      `generated: { by: ${yamlQuote(stamp.generatedBy)}, at: ${yamlQuote(stamp.generatedAt)} }`,
    );
  }
  if (stamp.verified?.length && !hasTopLevelKey(split.inner, "verified")) {
    additions.push(verificationYaml(stamp.verified));
  }
  if (additions.length === 0) return content;

  const inner = split.inner ? `${split.inner}\n${additions.join("\n")}` : additions.join("\n");
  return `${split.bom}---\n${inner}\n---${split.rest}`;
}

/**
 * Ensure the bundle-root index.md declares `okf_version` (OKF §12 — the only
 * frontmatter an index.md may carry). Creates the frontmatter block when the
 * listing has none; never touches an existing `okf_version`.
 */
export function stampRootIndex(content: string, okfVersion: string): string {
  const split = splitFrontmatter(content);
  if (!split) {
    const body = content.startsWith(BOM) ? content.slice(1) : content;
    return `---\nokf_version: ${yamlQuote(okfVersion)}\n---\n\n${body}`;
  }
  if (hasTopLevelKey(split.inner, "okf_version")) return content;
  const inner = split.inner
    ? `${split.inner}\nokf_version: ${yamlQuote(okfVersion)}`
    : `okf_version: ${yamlQuote(okfVersion)}`;
  return `${split.bom}---\n${inner}\n---${split.rest}`;
}

/**
 * Stamp every concept page under `wikiRoot` and the root index.md.
 * Intended for the publish candidate tree only (staging stays unstamped so
 * repair rounds and re-validation see the model's own output).
 */
export async function stampWikiTreeForPublish(
  wikiRoot: string,
  stamp: OkfStamp,
): Promise<OkfStampTreeResult> {
  const scan = await scanWikiTree(wikiRoot);
  const okfVersion = stamp.okfVersion ?? OKF_VERSION;
  let stampedPages = 0;
  let rootIndexStamped = false;

  for (const file of scan.files) {
    const rel = file.relativePath.replace(/\\/g, "/");
    if (!rel.toLowerCase().endsWith(".md")) continue;

    if (rel.toLowerCase() === "index.md") {
      const raw = await readFile(file.absolutePath, "utf8");
      const next = stampRootIndex(raw, okfVersion);
      if (next !== raw) {
        await writeFile(file.absolutePath, next, "utf8");
      }
      rootIndexStamped = true;
      continue;
    }
    if (isReservedWikiPath(rel)) continue;

    const raw = await readFile(file.absolutePath, "utf8");
    const next = stampConceptPage(raw, stamp);
    if (next !== raw) {
      await writeFile(file.absolutePath, next, "utf8");
      stampedPages += 1;
    }
  }

  return { stampedPages, rootIndexStamped };
}
