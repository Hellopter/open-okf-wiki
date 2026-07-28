/**
 * Source Citation API surface (ADR 0008).
 * Implementation is split across parse + canonicalize modules; this file
 * re-exports the public names for a stable import path.
 */

export {
  type SourceCitation,
  SOURCE_CITATION_RE,
  parseSourceCitations,
  validateCitationFormat,
} from "./citations-parse.js";

export {
  type CanonicalizeCitationOptions,
  type CanonicalizeCitationResult,
  type CanonicalizeWikiTreeResult,
  type SourceRootMap,
  canonicalizeCitationInContent,
  canonicalizeCitationTarget,
  canonicalizeWikiTreeCitations,
  formatRepoCitation,
  resolveCitationFile,
  sourceRootMapFromSources,
  validateCitationResolve,
} from "./citations-canonicalize.js";
